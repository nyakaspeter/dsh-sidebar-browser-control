import { BUILD, compatibility } from './compatibility.js';
import { interact } from './interactions.js';
import { readFile } from 'node:fs/promises';
import { stateDirectory } from './desktop.js';
import { join } from 'node:path';
import { CDP, endpoint, targets, website } from './cdp.js';
import { ScreenshotGuard } from './screenshot.js';

export class SidebarController {
  constructor(base) {
    this.base = endpoint(base);
    this.connections = new Map();
    this.pages = new Map();
    this.queues = new Map();
    this.connecting = new Map();
    this.disposed = false;
    this.screenshots = new ScreenshotGuard();
  }
  run(args, session, signal) {
    const next = (this.queues.get(session) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (this.disposed) throw Error('Browser controller disposed');
        signal?.throwIfAborted();
        return this.execute(args, session, signal);
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
  async execute(args, session, signal) {
    signal?.throwIfAborted();
    const discoveryStarted = Date.now();
    let all;
    try {
      all = await targets(this.base);
    } catch (error) {
      let detail = '';
      for (const file of ['restart-pending.txt', 'restart-error.txt']) {
        try {
          detail = await readFile(join(stateDirectory(), file), 'utf8');
          break;
        } catch {}
      }
      throw new Error(
        `DSH debugging is unavailable. ${detail || 'Automatic setup may still be starting. If it remains unavailable, quit and reopen DSH manually once.'} Do not repeatedly retry or restart in a loop.`,
        { cause: error },
      );
    }
    const live = new Set(all.map((t) => t.id));
    for (const [id, c] of this.connections)
      if (c.createdAt < discoveryStarted && !live.has(id)) this.release(c);
    const apps = all.filter(
      (t) => t.url === 'dsh-app://app/' && t.type === 'page',
    );
    if (apps.length !== 1)
      throw new Error('Expected exactly one DSH desktop window');
    const app = apps[0],
      main = await this.connection(app);
    const invoke = (method, ...params) =>
      main.evaluate(
        `(()=>{const api=window.__dshSidebarControl;if(!api)throw new Error('Sidebar plugin client is not loaded');return api[${JSON.stringify(method)}](...${JSON.stringify([session, ...params])});})()`,
        signal,
      );
    const client = await main.evaluate(
      'window.__dshSidebarControl?.status?.() ?? null',
      signal,
    );
    const problem = compatibility(client);
    if (args.action === 'status')
      return { hostBuild: BUILD, client, ...(problem ?? { ok: true }) };
    if (problem) return problem;
    if (args.action === 'open')
      return invoke('open', website(args.url), args.background !== false);
    if (args.action === 'list') return invoke('list');
    const tabKey = JSON.stringify([session, args.tabId]);
    const held = this.pages.get(tabKey);
    if (args.action === 'dialog') {
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
      );
      held.dialog = null;
      return { handled: true };
    }
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
      await main.evaluate(
        `(()=>{const view=[...document.querySelectorAll('webview')].find(v=>v.getAttribute('name')===${JSON.stringify(lease)});if(!view)throw new Error('Sidebar view disappeared');return view.executeJavaScript(${JSON.stringify(`globalThis.__dshSidebarLease = ${JSON.stringify(lease)}`)})})()`,
        signal,
      );
      for (const target of all.filter(
        (t) => t.type === 'webview' && t.parentId === app.id,
      )) {
        const candidate = await this.connection(target);
        if (candidate.lease && candidate.lease !== lease) continue;
        const bound = AbortSignal.timeout(750),
          probe = signal ? AbortSignal.any([signal, bound]) : bound;
        try {
          if (
            (await candidate.evaluate(
              'globalThis.__dshSidebarLease',
              probe,
            )) === lease
          ) {
            page = candidate;
            break;
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!bound.aborted && !error.dialog) throw error;
        }
      }
      if (!page)
        throw new Error(
          'Sidebar debugging target unavailable. Read once after loading finishes; do not retry in a loop.',
        );
      page.lease = lease;
      this.pages.set(tabKey, page);
      await page.call('Page.enable', {}, signal);
    }
    const call = (method, params) => page.call(method, params, signal);
    if (args.action === 'press') {
      const nativePage = {
        evaluate: (expression, s) => page.evaluate(expression, s),
        call: (method, params, s) => {
          if (method !== 'Input.dispatchKeyEvent')
            return page.call(method, params, s);
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
          return main.evaluate(
            `(()=>{const view=[...document.querySelectorAll('webview')].find(v=>v.getAttribute('name')===${JSON.stringify(lease)});if(!view)throw new Error('Browser view disappeared');view.sendInputEvent(${JSON.stringify(event)});${params.type === 'keyDown' && params.text ? `view.sendInputEvent(${JSON.stringify({ type: 'char', keyCode: params.text, modifiers })});` : ''}})()`,
            s,
          );
        },
      };
      return interact(nativePage, args, signal);
    }
    if (
      ['read', 'click', 'type', 'scroll', 'hover', 'drag', 'wait'].includes(
        args.action,
      )
    )
      return interact(page, args, signal);
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
        return this.screenshots.capture(JSON.stringify([session, args.tabId]), {
          signal,
          retry: args.retryScreenshot === true,
          visible: (s) =>
            main
              .evaluate('document.visibilityState', s)
              .then((v) => v !== 'hidden'),
          capture: (s) =>
            page.call('Page.captureScreenshot', { format: 'png' }, s),
        });
      case 'debug_start':
        page.recording = true;
        await call('Network.enable', {});
        await call('Runtime.enable', {});
        await call('Log.enable', {});
        return { recording: true };
      case 'debug_read':
        return page.drainEvents();
      case 'cdp': {
        if (
          !/^(Accessibility|DOM|CSS|Runtime|Network|Page|Input|Log|Performance|Debugger)\.[A-Za-z]+$/.test(
            args.method ?? '',
          )
        )
          throw new Error(
            'Unsupported CDP domain; browser/application target control is excluded',
          );
        if (
          [
            'Page.captureScreenshot',
            'Page.reload',
            'Page.navigateToHistoryEntry',
            'Input.dispatchKeyEvent',
          ].includes(args.method)
        )
          throw new Error(
            'Use screenshot, navigate or press for this command; they apply DSH guest routing and bounded failure handling.',
          );
        return call(args.method, JSON.parse(args.params ?? '{}'));
      }
      default:
        throw new Error(`Unknown action: ${args.action}`);
    }
  }
  dispose() {
    this.disposed = true;
    for (const c of [...this.connections.values()]) this.release(c);
    this.queues.clear();
    this.screenshots.blocked.clear();
  }
}
