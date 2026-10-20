import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BUILD, compatibility } from './compatibility.js';
import { CDP, targets, website } from './cdp.js';
import { stateDirectory } from './desktop.js';
import { EndpointCache } from './endpoint.js';
import { PageContext } from './frames.js';
import { interact } from './interactions.js';
import { domExpression } from './page-dom.js';
import { checkCdpCommand, parseCdpParams } from './policy.js';
import { combineRead, prefixRefs, readLimits } from './read.js';
import { ScreenshotGuard } from './screenshot.js';
import {
  MAX_DOWNLOAD_BYTES,
  createDownload,
  downloadsDirectory,
  fileName,
  hostFetch,
  resolveUploads,
  sanitizeName,
} from './transfer.js';

const APP_URL = 'dsh-app://app/';
const TARGET_TTL = 1000,
  CLIENT_TTL = 3000,
  WINDOW_TTL = 5000,
  MAX_FRAMES = 20,
  CHUNK = 4 * 1024 * 1024;
const J = JSON.stringify;
const unloaded =
  'Calling chat is not loaded in any DSH window. Open the chat once, then try again; do not retry in a loop.';

export class SidebarController {
  constructor({ endpoint, stateDir = stateDirectory() } = {}) {
    this.stateDir = stateDir;
    this.endpoints =
      typeof endpoint === 'string'
        ? { get: async () => endpoint, invalidate() {} }
        : (endpoint ?? new EndpointCache());
    this.base = null;
    this.connections = new Map();
    this.pages = new Map();
    this.queues = new Map();
    this.connecting = new Map();
    this.windows = new Map();
    this.targetCache = null;
    this.disposed = false;
    this.screenshots = new ScreenshotGuard();
  }
  run(args, session, signal, context = {}) {
    const next = (this.queues.get(session) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (this.disposed) throw Error('Browser controller disposed');
        signal?.throwIfAborted();
        return this.execute(args, session, signal, context);
      })
      .catch((error) => {
        if (error.dialog)
          return {
            ok: false,
            code: 'DIALOG_OPEN',
            dialog: error.dialog,
            message:
              'Inspect/handle the dialog before continuing; do not repeat the blocked action.',
          };
        throw error;
      });
    this.queues.set(session, next);
    const cleanup = () => {
      if (this.queues.get(session) === next) this.queues.delete(session);
    };
    next.then(cleanup, cleanup);
    return next;
  }
  forget(c) {
    for (const [id, connection] of this.connections)
      if (connection === c) this.connections.delete(id);
    for (const [key, page] of this.pages)
      if (page === c) {
        this.pages.delete(key);
        this.screenshots.clear(key);
      }
    c.context?.dispose();
    c.events.length = 0;
  }
  release(c) {
    this.forget(c);
    c.close();
  }
  async connection(target) {
    const held = this.connections.get(target.id);
    if (held?.ws.readyState === 1) return held;
    if (this.connecting.has(target.id)) return this.connecting.get(target.id);
    const pending = CDP.connect(target.webSocketDebuggerUrl, this.base).then(
      (c) => {
        if (this.disposed) {
          c.close();
          throw Error('Browser controller disposed');
        }
        c.createdAt = Date.now();
        this.connections.set(target.id, c);
        c.ws.once('close', () => this.forget(c));
        return c;
      },
    );
    this.connecting.set(target.id, pending);
    try {
      return await pending;
    } finally {
      if (this.connecting.get(target.id) === pending)
        this.connecting.delete(target.id);
    }
  }
  async unavailable(cause) {
    let detail = '';
    for (const file of ['restart-pending.txt', 'restart-error.txt']) {
      try {
        detail = await readFile(join(this.stateDir, file), 'utf8');
        break;
      } catch {}
    }
    return new Error(
      `DSH debugging is unavailable. ${detail || 'Automatic setup may still be starting. If it remains unavailable, quit and reopen DSH manually once.'} Do not repeatedly retry or restart in a loop.`,
      { cause },
    );
  }
  async targets(force = false) {
    const now = Date.now();
    if (!force && this.targetCache && now - this.targetCache.at < TARGET_TTL)
      return this.targetCache.list;
    const list = await targets(this.base);
    const live = new Set(list.map((t) => t.id));
    for (const [id, c] of this.connections)
      if (c.createdAt < now && !live.has(id)) this.release(c);
    this.targetCache = { at: now, list };
    return list;
  }
  // Each DSH window has its own plugin client; route to the one holding the chat.
  async windowFor(all, session, signal) {
    const apps = all.filter((t) => t.url === APP_URL && t.type === 'page');
    if (!apps.length) throw new Error('DSH application window not found');
    if (apps.length === 1) return apps[0];
    const cached = this.windows.get(session);
    if (cached && Date.now() - cached.at < WINDOW_TTL) {
      const app = apps.find((a) => a.id === cached.id);
      if (app) return app;
    }
    let fallback;
    for (const app of apps) {
      const c = await this.connection(app);
      const state = await c
        .evaluate(
          `window.__dshSidebarControl?.hasSession?.(${J(session)}) ?? null`,
          signal,
        )
        .catch(() => null);
      if (!state?.loaded) continue;
      fallback ??= app;
      if (state.visible) {
        fallback = app;
        break;
      }
    }
    if (!fallback) throw new Error(unloaded);
    this.windows.set(session, { id: fallback.id, at: Date.now() });
    return fallback;
  }
  async clientStatus(main, signal, force = false) {
    if (!force && main.client && Date.now() - main.client.at < CLIENT_TTL)
      return main.client.value;
    const value = await main.evaluate(
      'window.__dshSidebarControl?.status?.() ?? null',
      signal,
    );
    main.client = { at: Date.now(), value };
    return value;
  }
  async execute(args, session, signal, context = {}) {
    signal?.throwIfAborted();
    let base;
    try {
      base = await this.endpoints.get();
    } catch (error) {
      throw await this.unavailable(error);
    }
    if (!base) throw await this.unavailable();
    if (base !== this.base) {
      for (const c of [...this.connections.values()]) this.release(c);
      this.base = base;
      this.targetCache = null;
      this.windows.clear();
    }
    let all;
    try {
      all = await this.targets(args.action === 'status');
    } catch (error) {
      this.endpoints.invalidate();
      throw await this.unavailable(error);
    }
    const app = await this.windowFor(all, session, signal),
      main = await this.connection(app);
    const invoke = (method, ...params) =>
      main.evaluate(
        `(()=>{const api=window.__dshSidebarControl;if(!api)throw new Error('Sidebar plugin client is not loaded');return api[${J(method)}](...${J([session, ...params])});})()`,
        signal,
      );
    const client = await this.clientStatus(
      main,
      signal,
      args.action === 'status',
    );
    const problem = compatibility(client);
    if (args.action === 'status')
      return {
        hostBuild: BUILD,
        client,
        windows: all.filter((t) => t.url === APP_URL && t.type === 'page')
          .length,
        ...(problem ?? { ok: true }),
      };
    if (problem) return problem;
    if (args.action === 'open') {
      const result = await invoke(
        'open',
        website(args.url),
        args.background !== false,
      );
      this.targetCache = null;
      return result;
    }
    if (args.action === 'list') return invoke('list');
    const tabKey = J([session, args.tabId]);
    const held = this.pages.get(tabKey);
    if (args.action === 'dialog')
      return this.dialog(held, args, invoke, signal);
    if (held?.dialog && !['close', 'focus', 'hide'].includes(args.action))
      return {
        ok: false,
        code: 'DIALOG_OPEN',
        dialog: held.dialog,
        message: 'Use dialog inspect/accept/dismiss before continuing.',
      };
    if (['close', 'focus', 'hide'].includes(args.action)) {
      const result = await invoke(args.action, args.tabId);
      if (args.action === 'close') {
        if (held) this.release(held);
        this.screenshots.clear(tabKey);
        this.targetCache = null;
      }
      return result;
    }
    if (
      args.action === 'navigate' &&
      ['back', 'forward', 'reload'].includes(args.mode)
    )
      return invoke('navigate', args.tabId, args.mode);
    const lease = await invoke('lease', args.tabId);
    let page =
      held?.ws.readyState === 1 && held.lease === lease ? held : undefined;
    if (!page) {
      page = await this.locate(app, main, lease, signal);
      page.lease = lease;
      this.pages.set(tabKey, page);
    }
    page.context ??= new PageContext(page);
    await page.context.init(signal);
    return this.pageAction(page, main, args, session, signal, context, invoke);
  }
  // A one-time random global identifies the guest's debugging target.
  async locate(app, main, lease, signal) {
    const key = `__dshProbe_${randomUUID().replaceAll('-', '')}`;
    await main.evaluate(
      `(()=>{const view=[...document.querySelectorAll('webview')].find(v=>v.getAttribute('name')===${J(lease)});if(!view)throw new Error('Sidebar view disappeared');return view.executeJavaScript(${J(`globalThis[${J(key)}]=true`)})})()`,
      signal,
    );
    for (const force of [false, true]) {
      const list = await this.targets(force);
      for (const target of list.filter(
        (t) => t.type === 'webview' && t.parentId === app.id,
      )) {
        const candidate = await this.connection(target);
        if (candidate.lease && candidate.lease !== lease) continue;
        const bound = AbortSignal.timeout(750),
          probe = signal ? AbortSignal.any([signal, bound]) : bound;
        try {
          if (await candidate.evaluate(`globalThis[${J(key)}]===true`, probe)) {
            await candidate
              .evaluate(`delete globalThis[${J(key)}]`, probe)
              .catch(() => {});
            return candidate;
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!bound.aborted && !error.dialog) throw error;
        }
      }
    }
    throw new Error(
      'Sidebar debugging target unavailable. Read once after loading finishes; do not retry in a loop.',
    );
  }
  async dialog(held, args, invoke, signal) {
    await invoke('lease', args.tabId); // Enforce ownership without evaluating the blocked guest.
    if (!held || held.ws.readyState !== 1)
      return {
        dialog: null,
        message:
          'No tracked dialog. Read the page once before triggering JavaScript dialogs.',
      };
    if (!args.mode || args.mode === 'inspect')
      return {
        dialog: held.dialog,
        lastDialog: held.lastDialog,
        ...(!held.dialog && held.lastDialog
          ? {
              message:
                'This dialog is already closed. DSH or the user may have dismissed it. Do not retry opening it; inspect the page result.',
            }
          : {}),
      };
    if (!['accept', 'dismiss'].includes(args.mode))
      throw new Error('dialog mode must be inspect/accept/dismiss');
    if (!held.dialog) return { handled: false, reason: 'No dialog is open.' };
    await held.call(
      'Page.handleJavaScriptDialog',
      {
        accept: args.mode === 'accept',
        ...(args.text === undefined ? {} : { promptText: args.text }),
      },
      signal,
      held.dialog.sessionId,
    );
    held.dialog = null;
    return { handled: true };
  }
  async pageAction(page, main, args, session, signal, context, invoke) {
    const frames = page.context;
    const call = (method, params, s = signal) => page.call(method, params, s);
    // DOM helpers run in isolated worlds; frame-qualified refs route to their frame.
    const dom = async (action, a = args, s = signal) => {
      const { frame, ref } = frames.route(a.ref);
      const value = await frames.evaluate(
        frame,
        domExpression(action, { ...a, ref }),
        s,
      );
      if (frame && (action === 'point' || action === 'rect')) {
        const offset = await frames.offset(frame, s, { scroll: true });
        const x = value.x + offset.x,
          y = value.y + offset.y;
        // Out-of-process frames only receive input sent to their own session,
        // in coordinates relative to that session's root frame.
        if (action === 'point' && frame.sessionId) {
          const root = await frames.offset(
            {
              sessionId: frame.sessionId,
              frameId: frames.sessions.get(frame.sessionId)?.targetId,
              oopif: true,
            },
            s,
          );
          return { x: x - root.x, y: y - root.y, session: frame.sessionId };
        }
        return { ...value, x, y };
      }
      return value;
    };
    const adapter = {
      call: (method, params, s) => {
        if (params?.session === undefined) return page.call(method, params, s);
        const { session: sessionId, ...rest } = params;
        return page.call(method, rest, s, sessionId);
      },
      dom,
    };
    if (args.action === 'press')
      return interact(
        {
          ...adapter,
          call: (method, params, s) =>
            method === 'Input.dispatchKeyEvent'
              ? this.guestKey(main, page.lease, params, s)
              : page.call(method, params, s),
        },
        args,
        signal,
      );
    if (args.action === 'read') return this.read(page, args, signal);
    if (args.action === 'wait' && args.condition === 'networkidle')
      return this.networkIdle(page, args, signal);
    if (
      ['click', 'type', 'scroll', 'hover', 'drag', 'wait'].includes(args.action)
    )
      return interact(adapter, args, signal);
    switch (args.action) {
      case 'navigate': {
        const mode = args.mode ?? 'url';
        if (mode !== 'url')
          throw new Error('navigate mode must be url/back/forward/reload');
        const r = await call('Page.navigate', { url: website(args.url) });
        if (r.errorText) throw new Error(r.errorText);
        return r;
      }
      case 'evaluate':
        if (!args.expression) throw new Error('expression is required');
        return page.evaluate(args.expression, signal);
      case 'screenshot':
        return this.screenshot(page, main, args, session, signal, dom, invoke);
      case 'upload':
        return this.upload(page, args, session, signal, context);
      case 'download':
        return this.download(page, args, session, signal, dom);
      case 'debug_start':
        page.recording = true;
        await call('Network.enable', {});
        await call('Runtime.enable', {});
        await call('Log.enable', {});
        return { recording: true };
      case 'debug_read':
        return page.drainEvents();
      case 'cdp':
        return call(
          args.method,
          checkCdpCommand(args.method, parseCdpParams(args.params)),
        );
      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  }
  // Direct CDP key events reached the main DSH window; route through the guest.
  guestKey(main, lease, params, signal) {
    const modifiers = [];
    for (const [name, flag] of [
      ['alt', 1],
      ['control', 2],
      ['meta', 4],
      ['shift', 8],
    ])
      if (params.modifiers & flag) modifiers.push(name);
    const event = {
      type: params.type,
      keyCode:
        {
          ArrowLeft: 'Left',
          ArrowRight: 'Right',
          ArrowUp: 'Up',
          ArrowDown: 'Down',
          ' ': 'Space',
          Enter: 'Return',
        }[params.key] ?? params.key,
      modifiers,
    };
    const char =
      params.type === 'keyDown' && params.text
        ? `view.sendInputEvent(${J({ type: 'char', keyCode: params.text, modifiers })});`
        : '';
    return main.evaluate(
      `(()=>{const view=[...document.querySelectorAll('webview')].find(v=>v.getAttribute('name')===${J(lease)});if(!view)throw new Error('Browser view disappeared');view.sendInputEvent(${J(event)});${char}})()`,
      signal,
    );
  }
  async read(page, args, signal) {
    readLimits(args);
    const frames = page.context;
    const routed = frames.route(args.ref);
    frames.resetRefs();
    if (args.ref || args.selector) {
      const part = await frames.evaluate(
        routed.frame,
        domExpression('read', { ...args, ref: routed.ref }),
        signal,
      );
      const scoped = routed.frame
        ? prefixRefs(part, frames.register(routed.frame))
        : part;
      return combineRead([scoped], args, part.inaccessibleFrames);
    }
    const main = await frames.evaluate(
      undefined,
      domExpression('read', args),
      signal,
    );
    const parts = [main];
    let inaccessible = main.inaccessibleFrames ?? [];
    if (inaccessible.length || frames.sessions.size) {
      let list = [];
      try {
        list = await frames.isolatedFrames(signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error.dialog) throw error;
      }
      const viewport = await frames.evaluate(
        undefined,
        '({width: innerWidth, height: innerHeight})',
        signal,
      );
      for (const frame of list.slice(0, MAX_FRAMES)) {
        try {
          const frameOffset = await frames.offset(frame, signal);
          const part = await frames.evaluate(
            frame,
            domExpression('read', {
              ...args,
              ref: undefined,
              selector: undefined,
              frameOffset,
              viewport,
            }),
            signal,
          );
          parts.push(
            prefixRefs(
              { ...part, url: part.url || frame.url },
              frames.register(frame),
            ),
          );
          inaccessible = inaccessible.filter(
            (f) =>
              !sameDocument(f.src, part.url) && !sameDocument(f.src, frame.url),
          );
        } catch (error) {
          signal?.throwIfAborted();
          if (error.dialog) throw error;
        }
      }
    }
    return combineRead(parts, args, inaccessible);
  }
  // Idle: the document finished loading (covers requests from before the
  // plugin attached) and no tracked request was in flight for 500 ms.
  async networkIdle(page, args, signal) {
    const timeoutMs = args.timeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      throw Error('timeoutMs must be 1–10000.');
    const frames = page.context,
      inflight = frames.inflight;
    const bound = AbortSignal.timeout(timeoutMs),
      combined = signal ? AbortSignal.any([signal, bound]) : bound;
    try {
      let idleSince = Date.now();
      while (true) {
        const loaded =
          (await frames.evaluate(
            undefined,
            'document.readyState',
            combined,
          )) === 'complete';
        if (!loaded || inflight.size) idleSince = Date.now();
        else if (Date.now() - idleSince >= 500) return { matched: true };
        await delay(50, undefined, { signal: combined });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (bound.aborted)
        return {
          matched: false,
          code: 'WAIT_TIMEOUT',
          pendingRequests: inflight.size,
          message:
            'The network did not go idle within the deadline (long-polling pages may never idle). Read the page before deciding what to do next.',
        };
      throw error;
    }
  }
  async screenshot(page, main, args, session, signal, dom, invoke) {
    const format = args.format ?? 'png';
    if (!['png', 'jpeg'].includes(format))
      throw new Error('format must be png or jpeg');
    const quality = args.quality ?? 80;
    if (!Number.isInteger(quality) || quality < 1 || quality > 100)
      throw new Error('quality must be an integer 1–100');
    const element = !!(args.ref || args.selector);
    if (element && args.fullPage)
      throw new Error('Use either fullPage or an element target, not both.');
    // Resolve the element before the guard so a stale ref is an ordinary error.
    let clip;
    if (element) {
      const rect = await dom('rect');
      if (!(rect.width > 0 && rect.height > 0))
        throw new Error('Target has no visible area.');
      const metrics = await page.call('Page.getLayoutMetrics', {}, signal);
      const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      clip = {
        x: rect.x + viewport.pageX,
        y: rect.y + viewport.pageY,
        width: rect.width,
        height: rect.height,
        scale: 1,
      };
    }
    let clipped = false;
    const surface = await invoke?.('captureSurface', args.tabId, true).catch(
      () => null,
    );
    if (surface?.native && !surface.visible)
      return {
        ok: false,
        code: 'TAB_HIDDEN',
        retryable: false,
        message:
          'This native DSH tab is not on screen (sidebar collapsed, another tab active, or another chat visible), so Chromium is not drawing it and it cannot be captured. Continue with read. If the user wants to see a screenshot, focus the tab first (this reveals it in the sidebar) and take the screenshot again.',
      };
    const result = await this.screenshots
      .capture(J([session, args.tabId]), {
        signal,
        retry: args.retryScreenshot === true,
        timeoutMs: args.fullPage ? 10000 : undefined,
        visible: (s) =>
          main
            .evaluate('document.visibilityState', s)
            .then((v) => v !== 'hidden'),
        capture: async (s) => {
          const params = {
            format,
            ...(format === 'jpeg' && { quality }),
            ...(clip && { clip }),
          };
          if (args.fullPage) {
            const metrics = await page.call('Page.getLayoutMetrics', {}, s);
            const size = metrics.cssContentSize ?? metrics.contentSize;
            const width = Math.min(Math.ceil(size.width), 8192),
              height = Math.min(Math.ceil(size.height), 16384);
            clipped = width < size.width || height < size.height;
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width, height, scale: 1 };
          }
          return page.call('Page.captureScreenshot', params, s);
        },
      })
      .finally(() => {
        if (surface?.raised)
          invoke('captureSurface', args.tabId, false).catch(() => {});
      });
    return result?.data
      ? { ...result, mediaType: `image/${format}`, ...(clipped && { clipped }) }
      : result;
  }
  async upload(page, args, session, signal, context) {
    const files = await resolveUploads(args.files, {
      cwd: context.cwd,
      roots: [downloadsDirectory(session, this.stateDir)],
    });
    const { frame, ref } = page.context.route(args.ref);
    const handle = await page.context.evaluate(
      frame,
      domExpression('fileInput', { ...args, ref, count: files.length }),
      signal,
      { byValue: false },
    );
    try {
      await page.call(
        'DOM.setFileInputFiles',
        { files, objectId: handle.objectId },
        signal,
        frame?.sessionId,
      );
    } finally {
      page
        .call(
          'Runtime.releaseObject',
          { objectId: handle.objectId },
          AbortSignal.timeout(1000),
          frame?.sessionId,
        )
        .catch(() => {});
    }
    return { uploaded: files.length, files: files.map((f) => basename(f)) };
  }
  // In-page fetch keeps the page's cookies and origin; a CORS failure falls back
  // to a host fetch with that URL's cookies, refused for private networks.
  async download(page, args, session, signal, dom) {
    const frames = page.context;
    const { frame } = frames.route(args.ref);
    const source = website(args.url ?? (await dom('href')).url);
    const key = `__dshDownload_${randomUUID().replaceAll('-', '')}`;
    let meta;
    try {
      meta = await frames.evaluate(
        frame,
        `(${inPageFetch})(${J(source)},${J(key)},${MAX_DOWNLOAD_BYTES})`,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error.dialog) throw error;
      meta = { error: error.message };
    }
    if (meta.tooLarge)
      throw new Error(
        `Download exceeds the ${MAX_DOWNLOAD_BYTES / 1048576} MB limit.`,
      );
    if (meta.status) throw new Error(`Download failed: HTTP ${meta.status}`);
    const directory = downloadsDirectory(session, this.stateDir);
    const nameFor = (info) =>
      args.text
        ? sanitizeName(args.text)
        : fileName({ disposition: info.disposition, url: info.url });
    let result;
    if (meta.size !== undefined) {
      const info = {
        mediaType: meta.type,
        disposition: meta.disposition,
        url: meta.url,
      };
      const file = await createDownload(directory, nameFor(info));
      try {
        // Each chunk goes straight to disk; memory stays at one chunk.
        for (let start = 0; start < meta.size; start += CHUNK)
          await file.write(
            Buffer.from(
              await frames.evaluate(
                frame,
                `(${readChunk})(${J(key)},${start},${start + CHUNK})`,
                signal,
              ),
              'base64',
            ),
          );
        await file.finish();
      } catch (error) {
        await file.abort();
        throw error;
      } finally {
        frames
          .evaluate(
            frame,
            `delete globalThis[${J(key)}]`,
            AbortSignal.timeout(1000),
          )
          .catch(() => {});
      }
      result = { ...info, path: file.path, bytes: file.bytes, via: 'page' };
    } else {
      const [referer, userAgent] = await frames.evaluate(
        undefined,
        '[location.href, navigator.userAgent]',
        signal,
      );
      result = {
        ...(await hostFetch(source, {
          signal,
          referer,
          userAgent,
          open: (info) => createDownload(directory, nameFor(info)),
          cookiesFor: async (url) =>
            (
              await page.call('Network.getCookies', { urls: [url] }, signal)
            ).cookies
              .map((c) => `${c.name}=${c.value}`)
              .join('; '),
        })),
        via: 'host',
      };
    }
    return {
      path: result.path,
      bytes: result.bytes,
      ...(result.mediaType && { mediaType: result.mediaType }),
      url: result.url,
      via: result.via,
    };
  }
  dispose() {
    this.disposed = true;
    for (const c of [...this.connections.values()]) this.release(c);
    this.queues.clear();
    this.screenshots.blocked.clear();
  }
}
function sameDocument(a, b) {
  if (!a || !b) return false;
  try {
    const x = new URL(a),
      y = new URL(b);
    x.hash = y.hash = '';
    return x.href === y.href;
  } catch {
    return a === b;
  }
}
// Serialized into the page's isolated world.
async function inPageFetch(url, key, max) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  if (!response.ok) return { status: response.status };
  if (Number(response.headers.get('content-length')) > max)
    return { tooLarge: true };
  const blob = await response.blob();
  if (blob.size > max) return { tooLarge: true };
  globalThis[key] = blob;
  return {
    size: blob.size,
    type: blob.type || response.headers.get('content-type') || undefined,
    disposition: response.headers.get('content-disposition') || undefined,
    url: response.url,
  };
}
async function readChunk(key, start, end) {
  const blob = globalThis[key];
  if (!blob) throw Error('Download buffer expired; download again.');
  const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(text);
}
