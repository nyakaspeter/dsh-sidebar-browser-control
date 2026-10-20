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
    this.inflight = new Set(); // main-frame-session requests still loading
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
        cdp.on('Target.attachedToTarget', (event, parent) => {
          if (event.targetInfo.type !== 'iframe') return;
          this.sessions.set(event.sessionId, {
            targetId: event.targetInfo.targetId,
            url: event.targetInfo.url,
            parent,
          });
          void cdp
            .call('Page.enable', {}, undefined, event.sessionId)
            .then(() =>
              cdp.call(
                'Target.setAutoAttach',
                autoAttach,
                undefined,
                event.sessionId,
              ),
            )
            .catch(() => {});
        }),
        cdp.on('Target.detachedFromTarget', ({ sessionId }) => {
          this.sessions.delete(sessionId);
          for (const key of this.worlds.keys())
            if (key.startsWith(`${sessionId}|`)) this.worlds.delete(key);
        }),
      );
      // Track requests from first attach so network idle also sees requests
      // that started before a wait began.
      const done = ({ requestId }, sessionId) => {
        if (!sessionId) this.inflight.delete(requestId);
      };
      this.disposers.push(
        cdp.on('Network.requestWillBeSent', (event, sessionId) => {
          if (!sessionId && event.type !== 'EventSource')
            this.inflight.add(event.requestId);
        }),
        cdp.on('Network.loadingFinished', done),
        cdp.on('Network.loadingFailed', done),
      );
      await cdp.call('Page.enable', {}, signal);
      await cdp.call('Network.enable', {}, signal).catch(() => {});
      // Older or restricted targets may refuse auto-attach; cross-origin
      // out-of-process frames are then reported as inaccessible.
      await cdp
        .call('Target.setAutoAttach', autoAttach, signal)
        .catch(() => {});
    })();
    return this.ready;
  }
  forget(sessionId = '', frameId) {
    this.worlds.delete(`${sessionId}|${frameId}`);
  }
  dispose() {
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
