import test from 'node:test';
import assert from 'node:assert/strict';
import { PageContext, WORLD } from '../src/frames.js';

// Minimal flattened CDP double: handlers keyed by "sessionId|method".
function fakeCdp(handlers) {
  const listeners = new Map(),
    calls = [];
  return {
    calls,
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
      return () => {};
    },
    emit(method, params, sessionId) {
      for (const fn of listeners.get(method) ?? []) fn(params, sessionId);
    },
    async call(method, params = {}, _signal, sessionId) {
      calls.push([sessionId ?? '', method, params]);
      const handler =
        handlers[`${sessionId ?? ''}|${method}`] ?? handlers[method];
      if (!handler) return {};
      return handler(params, sessionId);
    },
  };
}
const tree = (id, origin, children = [], url = `${origin}/`) => ({
  frame: { id, securityOrigin: origin, url },
  childFrames: children,
});

test('DOM code runs in a cached isolated world and survives navigation', async () => {
  let worlds = 0,
    stale = true;
  const cdp = fakeCdp({
    'Page.getFrameTree': () => ({ frameTree: tree('main', 'https://a.test') }),
    'Page.createIsolatedWorld': (p) => {
      assert.equal(p.worldName, WORLD);
      return { executionContextId: ++worlds };
    },
    'Runtime.evaluate': (p) => {
      assert.equal(p.contextId, worlds);
      if (p.contextId === 1 && !stale) throw new Error('unreachable');
      if (p.expression === 'nav' && stale) {
        stale = false;
        throw new Error('Cannot find context with specified id');
      }
      return { result: { value: p.contextId } };
    },
  });
  const ctx = new PageContext(cdp);
  await ctx.init();
  assert.equal(await ctx.evaluate(undefined, '1'), 1);
  assert.equal(await ctx.evaluate(undefined, '2'), 1, 'world is reused');
  assert.equal(await ctx.evaluate(undefined, 'nav'), 2, 'recreated once');
  assert.equal(worlds, 2);
  cdp.emit('Page.frameNavigated', { frame: { id: 'main' } });
  await ctx.evaluate(undefined, '3');
  assert.equal(worlds, 3, 'navigation invalidates the world');
  assert.ok(
    cdp.calls.some(
      ([, m, p]) => m === 'Target.setAutoAttach' && p.flatten === true,
    ),
  );
});
test('page exceptions in the world are reported, not retried', async () => {
  let evaluations = 0;
  const cdp = fakeCdp({
    'Page.getFrameTree': () => ({ frameTree: tree('main', 'https://a.test') }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 1 }),
    'Runtime.evaluate': () => (
      evaluations++,
      { exceptionDetails: { exception: { description: 'Error: boom' } } }
    ),
  });
  const ctx = new PageContext(cdp);
  await assert.rejects(ctx.evaluate(undefined, 'x'), /boom/);
  assert.equal(evaluations, 1);
});
test('isolated frames include cross-origin and out-of-process frames once', async () => {
  const cdp = fakeCdp({
    '|Page.getFrameTree': () => ({
      frameTree: tree('main', 'https://a.test', [
        tree('same', 'https://a.test'),
        tree('ads', 'https://ads.test', [tree('adsChild', 'https://ads.test')]),
        tree('oop', 'https://b.test'),
        tree('sandboxed', 'null'),
      ]),
    }),
    's1|Page.getFrameTree': () => ({
      frameTree: tree('oop', 'https://b.test', [
        tree('inner', 'https://c.test'),
      ]),
    }),
  });
  const ctx = new PageContext(cdp);
  await ctx.init();
  cdp.emit('Target.attachedToTarget', {
    sessionId: 's1',
    targetInfo: { type: 'iframe', targetId: 'oop', url: 'https://b.test/' },
  });
  const frames = await ctx.isolatedFrames();
  assert.deepEqual(
    frames.map((f) => [f.frameId, f.sessionId ?? '', !!f.oopif]),
    [
      ['ads', '', false],
      ['oop', 's1', true],
      ['sandboxed', '', false],
      ['inner', 's1', false],
    ],
  );
});
test('frame offsets accumulate owner boxes across out-of-process sessions', async () => {
  const box = (x, y) => ({ model: { content: [x, y, 0, 0, 0, 0, 0, 0] } });
  const cdp = fakeCdp({
    '|DOM.getFrameOwner': (p) => {
      if (p.frameId === 'oop') return { backendNodeId: 1 };
      throw new Error('Frame not found');
    },
    's1|DOM.getFrameOwner': (p) => {
      if (p.frameId === 'inner') return { backendNodeId: 2 };
      throw new Error('Frame not found');
    },
    '|DOM.getBoxModel': () => box(100, 50),
    's1|DOM.getBoxModel': () => box(10, 5),
  });
  const ctx = new PageContext(cdp);
  ctx.sessions.set('s1', { targetId: 'oop' });
  assert.deepEqual(
    await ctx.offset({ sessionId: 's1', frameId: 'oop', oopif: true }),
    { x: 100, y: 50 },
  );
  assert.deepEqual(await ctx.offset({ sessionId: 's1', frameId: 'inner' }), {
    x: 110,
    y: 55,
  });
  assert.ok(
    !cdp.calls.some(([, m]) => m === 'DOM.scrollIntoViewIfNeeded'),
    'reads never scroll frames into view',
  );
  await ctx.offset({ sessionId: 's1', frameId: 'inner' }, undefined, {
    scroll: true,
  });
  assert.ok(cdp.calls.some(([, m]) => m === 'DOM.scrollIntoViewIfNeeded'));
});
test('frame-qualified refs route to their frame and expire on the next read', () => {
  const ctx = new PageContext(fakeCdp({}));
  const frame = { sessionId: 's1', frameId: 'x' };
  const key = ctx.register(frame);
  assert.deepEqual(ctx.route(`${key}:r1-2`), { frame, ref: 'r1-2' });
  assert.deepEqual(ctx.route('r1-2'), { frame: undefined, ref: 'r1-2' });
  ctx.resetRefs();
  assert.throws(() => ctx.route(`${key}:r1-2`), /Stale/);
});
test('in-flight main-frame requests are tracked from the first attach', async () => {
  const cdp = fakeCdp({});
  const ctx = new PageContext(cdp);
  await ctx.init();
  assert.ok(cdp.calls.some(([, m]) => m === 'Network.enable'));
  cdp.emit('Network.requestWillBeSent', { requestId: 'a', type: 'XHR' });
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'sse',
    type: 'EventSource',
  });
  cdp.emit(
    'Network.requestWillBeSent',
    { requestId: 'oop', type: 'XHR' },
    's1',
  );
  assert.deepEqual([...ctx.inflight.keys()], ['a']);
  cdp.emit('Network.loadingFailed', { requestId: 'a' });
  assert.equal(ctx.inflight.size, 0);
  // An out-of-process iframe document finishes in the iframe's session.
  cdp.emit('Network.requestWillBeSent', {
    requestId: 'frame',
    type: 'Document',
  });
  cdp.emit('Network.loadingFinished', { requestId: 'frame' }, 's1');
  assert.equal(ctx.inflight.size, 0);
});
test('iframe sessions attached before init are adopted with network events', async () => {
  const cdp = fakeCdp({});
  cdp.children = new Map([
    ['early', { type: 'iframe', targetId: 'oop', url: 'https://b.test/' }],
    ['worker', { type: 'worker', targetId: 'w' }],
  ]);
  const ctx = new PageContext(cdp);
  await ctx.init();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...ctx.sessions.keys()], ['early']);
  assert.ok(
    cdp.calls.some(([sid, m]) => sid === 'early' && m === 'Network.enable'),
  );
});
