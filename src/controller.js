import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BUILD, compatibility } from './compatibility.js';
import { CDP, targets, website } from './cdp.js';
import { stateDirectory } from './desktop.js';
import { EndpointCache } from './endpoint.js';
import { PageContext } from './frames.js';
import { interact } from './interactions.js';
import { domExpression } from './page-dom.js';
import { combineRead, prefixRefs, readLimits } from './read.js';
import { ScreenshotGuard } from './screenshot.js';
import {
  downloadThroughPage,
  downloadsDirectory,
  fileName,
  resolveUploads,
  sanitizeName,
} from './transfer.js';

const APP_URL = 'dsh-app://app/';
const TARGET_TTL = 1000,
  CLIENT_TTL = 3000,
  MAX_FRAMES = 20,
  FIND_LIMIT = 8;
const J = JSON.stringify;
// Runs statements with `view` bound to the guest webview that holds this lease.
const inView = (lease, body) =>
  `(()=>{const view=[...document.querySelectorAll('webview')].find(v=>v.getAttribute('name')===${J(lease)});if(!view)throw new Error('Browser view disappeared; read the page again.');${body}})()`;

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
  appWindow(all) {
    const app = all.find((t) => t.url === APP_URL && t.type === 'page');
    if (!app) throw new Error('DSH application window not found');
    return app;
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
    }
    let all;
    try {
      all = await this.targets(args.action === 'status');
    } catch (error) {
      this.endpoints.invalidate();
      throw await this.unavailable(error);
    }
    const app = this.appWindow(all),
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
        ...(problem ?? { ok: true }),
      };
    if (problem) return problem;
    if (args.action === 'open') {
      const result = await invoke(
        'open',
        website(args.url),
        args.background !== false,
        { deferLoad: true },
      );
      this.targetCache = null;
      // Plugin tabs wait on about:blank so logging covers the first load.
      if (result?.pendingLoad) {
        try {
          const lease = await invoke('lease', result.tabId);
          const page = await this.locate(app, main, lease, signal);
          page.lease = lease;
          page.context ??= new PageContext(page);
          await page.context.init(signal);
          this.pages.set(J([session, result.tabId]), page);
        } catch {
          signal?.throwIfAborted();
        } finally {
          await invoke('load', result.tabId);
        }
        delete result.pendingLoad;
      }
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
    return this.pageAction(page, args, {
      main,
      session,
      signal,
      context,
      invoke,
    });
  }
  // A one-time random global identifies the guest's debugging target.
  // The marker lives briefly in the page's main world (webview.executeJavaScript
  // has no isolated variant); its name is random and it is deleted on match.
  // Connections opened only to probe are closed again.
  async locate(app, main, lease, signal) {
    const key = `__dshProbe_${randomUUID().replaceAll('-', '')}`;
    await main.evaluate(
      inView(
        lease,
        `return view.executeJavaScript(${J(`globalThis[${J(key)}]=true`)})`,
      ),
      signal,
    );
    for (const force of [false, true]) {
      const list = await this.targets(force);
      for (const target of list.filter(
        (t) => t.type === 'webview' && t.parentId === app.id,
      )) {
        const held = this.connections.has(target.id);
        const candidate = await this.connection(target);
        if (candidate.lease && candidate.lease !== lease) continue;
        const bound = AbortSignal.timeout(750),
          probe = signal ? AbortSignal.any([signal, bound]) : bound;
        let found = false;
        try {
          found = await candidate.evaluate(
            `globalThis[${J(key)}]===true`,
            probe,
          );
          if (found)
            await candidate
              .evaluate(`delete globalThis[${J(key)}]`, probe)
              .catch(() => {});
        } catch (error) {
          signal?.throwIfAborted();
          if (!bound.aborted && !error.dialog) throw error;
        }
        if (found) return candidate;
        if (!held) this.release(candidate);
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
          'No tracked dialog. Dialogs are tracked from open for plugin tabs, and from the first action for tabs the user opened.',
      };
    if (args.mode === 'inspect')
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
  async pageAction(page, args, { main, session, signal, context, invoke }) {
    const frames = page.context;
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
    // Key events and text insertion go through the guest webview: direct CDP
    // key dispatch reached the main DSH window.
    const input = {
      call: (method, params, s, sessionId) =>
        method === 'Input.dispatchKeyEvent'
          ? this.guestKey(main, page.lease, params, s)
          : page.call(method, params, s, sessionId),
      on: (method, fn) => page.on(method, fn),
      dom,
      insertText: (text, s) =>
        main.evaluate(
          inView(page.lease, `return view.insertText(${J(text)})`),
          s,
        ),
    };
    switch (args.action) {
      case 'read':
        return this.read(page, args, signal);
      case 'find':
        return this.find(frames, args, signal);
      case 'logs':
        return frames.logs.query(args, signal);
      case 'wait':
        if (args.condition === 'networkidle')
          return frames.networkIdle(args.timeoutMs, signal);
        return interact(input, args, signal);
      // A click or key can start a navigation: report where it went once
      // it has loaded, so the agent never acts on the old page.
      case 'click':
      case 'press':
        return this.navigating(frames, args, signal, () =>
          interact(input, args, signal),
        );
      case 'type':
      case 'scroll':
      case 'hover':
      case 'drag':
        return interact(input, args, signal);
      // back/forward/reload go through the guest webview in execute().
      case 'navigate':
        return this.navigating(frames, args, signal, async () => {
          const r = await page.call(
            'Page.navigate',
            { url: website(args.url) },
            signal,
          );
          if (r.errorText) throw new Error(r.errorText);
          return { navigated: true };
        });
      case 'evaluate':
        return page.evaluate(args.expression, signal);
      case 'screenshot':
        return this.screenshot(page, main, args, session, signal, dom, invoke);
      case 'upload':
        return this.upload(page, args, session, signal, context);
      case 'download': {
        const { frame } = frames.route(args.ref);
        const link = args.url ? null : await dom('href');
        return downloadThroughPage({
          evaluate: (expression, s) => frames.evaluate(frame, expression, s),
          source: website(args.url ?? link.url),
          directory: downloadsDirectory(session, this.stateDir),
          // Like a browser: header name, then the link's download attribute.
          name: (meta) =>
            args.text
              ? sanitizeName(args.text)
              : fileName({ ...meta, suggested: link?.download }),
          signal,
        });
      }
      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  }
  async navigating(frames, args, signal, action) {
    const watch = frames.watchNavigation();
    try {
      const result = await action();
      const navigation = await watch.settle(args.timeoutMs, signal);
      return navigation ? { ...result, navigation } : result;
    } finally {
      watch.dispose();
    }
  }
  // Translates a CDP key event into the guest's own input events.
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
          '+': 'Plus',
        }[params.key] ?? params.key,
      modifiers,
    };
    const char =
      params.type === 'keyDown' && params.text
        ? `view.sendInputEvent(${J({ type: 'char', keyCode: params.text, modifiers })});`
        : '';
    return main.evaluate(
      inView(lease, `view.sendInputEvent(${J(event)});${char}`),
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
      const list = await this.otherFrames(frames, signal);
      const viewport = await frames.evaluate(
        undefined,
        '({width: innerWidth, height: innerHeight})',
        signal,
      );
      for (const frame of list) {
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
  // Cross-origin frames the main document's walk cannot reach, capped.
  async otherFrames(frames, signal) {
    try {
      return (await frames.isolatedFrames(signal)).slice(0, MAX_FRAMES);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.dialog) throw error;
      return [];
    }
  }
  // Searches the main document first, then cross-origin frames until enough
  // matches are found; frame matches get frame-qualified refs.
  async find(frames, args, signal) {
    const main = await frames.evaluate(
      undefined,
      domExpression('find', args),
      signal,
    );
    const found = main.found;
    if (
      found.length < FIND_LIMIT &&
      (main.inaccessible || frames.sessions.size)
    )
      for (const frame of await this.otherFrames(frames, signal)) {
        if (found.length >= FIND_LIMIT) break;
        try {
          const part = await frames.evaluate(
            frame,
            domExpression('find', args),
            signal,
          );
          if (!part.found.length) continue;
          const key = frames.register(frame);
          for (const item of part.found)
            found.push({ ...item, ref: `${key}:${item.ref}` });
        } catch (error) {
          signal?.throwIfAborted();
          if (error.dialog) throw error;
        }
      }
    return { url: main.url, found: found.slice(0, FIND_LIMIT) };
  }
  async screenshot(page, main, args, session, signal, dom, invoke) {
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
    const surface = await invoke('captureSurface', args.tabId, true).catch(
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
            format: 'png',
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
      ? { ...result, mediaType: 'image/png', ...(clipped && { clipped }) }
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
  dispose() {
    this.disposed = true;
    for (const c of [...this.connections.values()]) this.release(c);
    this.queues.clear();
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
