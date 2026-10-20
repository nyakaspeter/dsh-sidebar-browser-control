import { PageLogs } from './logs.js';
// Execution contexts for one guest page connection. Plugin DOM code runs in a
// CDP isolated world: pages cannot observe or monkeypatch it, and stored element
// references live outside the page's own JavaScript. Cross-origin iframes get
// their own worlds; out-of-process ones arrive as flattened child sessions.
export const WORLD = 'dsh-sidebar-browser';
const STALE =
  /Cannot find context|Execution context was destroyed|No frame|Inspected target navigated|uniqueContextId/i;

export class PageContext {
  constructor(cdp) {
    this.cdp = cdp;
    this.worlds = new Map();
    this.sessions = new Map(); // sessionId -> { targetId, url }
    this.refFrames = new Map(); // "f1" -> frame
    this.mainFrame = null;
    this.ready = null;
    this.disposers = [];
    this.inflight = new Map(); // request id -> url, still loading
    this.logs = new PageLogs(cdp);
  }
  init(signal) {
    this.ready ??= (async () => {
      const cdp = this.cdp;
      this.disposers.push(
        cdp.on('Page.frameNavigated', ({ frame }, sessionId) => {
          this.forget(sessionId, frame.id);
          if (!frame.parentId && !sessionId) this.mainFrame = frame.id;
        }),
        cdp.on('Page.frameDetached', ({ frameId }, sessionId) =>
          this.forget(sessionId, frameId),
        ),
        cdp.on('Target.attachedToTarget', (event, parent) =>
          this.adopt(event.sessionId, { ...event.targetInfo, parent }),
        ),
        cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
          this.sessions.delete(sessionId);
          for (const key of this.worlds.keys())
            if (key.startsWith(`${sessionId}|`)) this.worlds.delete(key);
        }),
      );
      // Track requests from first attach so network idle also sees requests
      // that started before a wait began.
      // An out-of-process iframe's document request starts in this session
      // but finishes in the iframe's own session; request ids are unique.
      const done = ({ requestId }) => this.inflight.delete(requestId);
      this.disposers.push(
        cdp.on('Network.requestWillBeSent', (event, sessionId) => {
          // Iframe documents finish in other sessions (out-of-process
          // frames), possibly before tracking reaches them, so only the main
          // document and main-frame-session subrequests count.
          if (
            sessionId ||
            event.type === 'EventSource' ||
            (event.type === 'Document' &&
              this.mainFrame &&
              event.frameId !== this.mainFrame)
          )
            return;
          this.inflight.set(event.requestId, event.request?.url);
        }),
        cdp.on('Network.loadingFinished', done),
        cdp.on('Network.loadingFailed', done),
      );
      for (const [sessionId, info] of cdp.children ?? [])
        this.adopt(sessionId, info);
      await cdp.call('Page.enable', {}, signal);
      await this.main(signal).catch(() => {});
      this.logs.listen();
      await cdp.call('Network.enable', {}, signal).catch(() => {});
      await this.logs.enable(undefined, signal);
      // Older or restricted targets may refuse auto-attach; cross-origin
      // out-of-process frames are then reported as inaccessible.
      await cdp
        .call('Target.setAutoAttach', autoAttach, signal)
        .catch(() => {});
    })();
    return this.ready;
  }
  // Out-of-process iframe sessions: track them and enable the domains frame
  // reads and network-idle tracking need.
  adopt(sessionId, info) {
    if (info.type !== 'iframe' || this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      targetId: info.targetId,
      url: info.url,
      parent: info.parent,
    });
    const call = (method, params = {}) =>
      this.cdp.call(method, params, undefined, sessionId);
    void call('Page.enable')
      .then(() => call('Network.enable'))
      .then(() => this.logs.enable(sessionId))
      .then(() => call('Target.setAutoAttach', autoAttach))
      .catch(() => {});
  }
  forget(sessionId = '', frameId) {
    this.worlds.delete(`${sessionId}|${frameId}`);
  }
  dispose() {
    this.logs.dispose();
    for (const off of this.disposers.splice(0)) off();
  }
  async main(signal) {
    if (!this.mainFrame) {
      const { frameTree } = await this.cdp.call(
        'Page.getFrameTree',
        {},
        signal,
      );
      this.mainFrame = frameTree.frame.id;
    }
    return { sessionId: undefined, frameId: this.mainFrame, main: true };
  }
  async world(frame, signal) {
    const key = `${frame.sessionId ?? ''}|${frame.frameId}`;
    if (this.worlds.has(key)) return this.worlds.get(key);
    const { executionContextId } = await this.cdp.call(
      'Page.createIsolatedWorld',
      { frameId: frame.frameId, worldName: WORLD },
      signal,
      frame.sessionId,
    );
    this.worlds.set(key, executionContextId);
    return executionContextId;
  }
  // Evaluates in the frame's isolated world, recreating it once after navigation.
  async evaluate(frame, expression, signal, { byValue = true } = {}) {
    frame ??= await this.main(signal);
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.world(frame, signal);
      try {
        const result = await this.cdp.call(
          'Runtime.evaluate',
          {
            expression,
            contextId,
            awaitPromise: true,
            returnByValue: byValue,
          },
          signal,
          frame.sessionId,
        );
        if (result.exceptionDetails) {
          const message =
            result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text;
          throw new Error(message);
        }
        return byValue ? result.result.value : result.result;
      } catch (error) {
        if (attempt || error.dialog || !STALE.test(error.message)) throw error;
        this.forget(frame.sessionId, frame.frameId);
        if (frame.main) this.mainFrame = null;
        if (frame.main) frame = await this.main(signal);
      }
    }
  }
  // Frames whose content the main-world walk cannot reach: in-process frames
  // whose origin differs from their parent, and out-of-process frame roots.
  async isolatedFrames(signal) {
    const frames = [];
    const visit = (node, sessionId, parentOrigin, root) => {
      const { frame } = node;
      const origin = frame.securityOrigin ?? '';
      if (!root && (origin !== parentOrigin || origin === 'null'))
        frames.push({ sessionId, frameId: frame.id, url: frame.url });
      for (const child of node.childFrames ?? [])
        visit(child, sessionId, origin, false);
    };
    const tree = await this.cdp.call('Page.getFrameTree', {}, signal);
    visit(tree.frameTree, undefined, '', true);
    for (const sessionId of this.sessions.keys()) {
      try {
        const child = await this.cdp.call(
          'Page.getFrameTree',
          {},
          signal,
          sessionId,
        );
        frames.push({
          sessionId,
          frameId: child.frameTree.frame.id,
          url: child.frameTree.frame.url,
          oopif: true,
        });
        visit(
          child.frameTree,
          sessionId,
          child.frameTree.frame.securityOrigin,
          true,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (error.dialog) throw error;
      }
    }
    // A remote frame can also appear in its parent's tree; its own session wins.
    const unique = new Map();
    for (const frame of frames)
      if (!unique.has(frame.frameId) || frame.oopif)
        unique.set(frame.frameId, frame);
    return [...unique.values()];
  }
  // Top-level viewport offset of a frame's content box.
  async offset(frame, signal, { scroll = false, depth = 0 } = {}) {
    if (frame.main || depth > 8) return { x: 0, y: 0 };
    const owners = [frame.sessionId, undefined, ...this.sessions.keys()].filter(
      (v, i, all) => all.indexOf(v) === i,
    );
    for (const sessionId of owners) {
      if (frame.oopif && sessionId === frame.sessionId) continue;
      try {
        const { backendNodeId } = await this.cdp.call(
          'DOM.getFrameOwner',
          { frameId: frame.frameId },
          signal,
          sessionId,
        );
        if (scroll)
          await this.cdp
            .call(
              'DOM.scrollIntoViewIfNeeded',
              { backendNodeId },
              signal,
              sessionId,
            )
            .catch(() => {});
        const { model } = await this.cdp.call(
          'DOM.getBoxModel',
          { backendNodeId },
          signal,
          sessionId,
        );
        const base = sessionId
          ? await this.offset(
              {
                sessionId,
                frameId: this.sessions.get(sessionId)?.targetId,
                oopif: true,
              },
              signal,
              { scroll, depth: depth + 1 },
            )
          : { x: 0, y: 0 };
        return { x: base.x + model.content[0], y: base.y + model.content[1] };
      } catch (error) {
        signal?.throwIfAborted();
        if (error.dialog) throw error;
      }
    }
    throw new Error('Frame position is unavailable; read the page again.');
  }
  // Frame-qualified references: "f2:r1a2b3c4-5" routes to registered frame 2.
  register(frame) {
    const key = `f${this.refFrames.size + 1}`;
    this.refFrames.set(key, frame);
    return key;
  }
  resetRefs() {
    this.refFrames.clear();
  }
  route(ref) {
    const match = /^(f\d+):(.+)$/.exec(ref ?? '');
    if (!match) return { frame: undefined, ref };
    const frame = this.refFrames.get(match[1]);
    if (!frame)
      throw new Error('Stale element reference; read the page again.');
    return { frame, ref: match[2] };
  }
}
const autoAttach = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};
