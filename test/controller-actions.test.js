import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidebarController } from '../src/controller.js';

const dir = () => mkdtemp(join(tmpdir(), 'dsh-ctl-'));
// A guest page double with a fake isolated-world context.
function fakePage({ dom = {}, calls = [], handlers = {} } = {}) {
  const listeners = new Map();
  const page = {
    calls,
    lease: 'lease',
    on(method, fn) {
      listeners.set(method, fn);
      return () => listeners.delete(method);
    },
    emit: (method, params) => listeners.get(method)?.(params),
    async call(method, params, _signal, sessionId) {
      calls.push({ method, params, sessionId });
      return handlers[method]?.(params) ?? {};
    },
    async evaluate() {
      return 'main-world';
    },
  };
  page.context = {
    route: (ref) =>
      ref?.startsWith('f1:')
        ? { frame: { sessionId: 'child', frameId: 'f' }, ref: ref.slice(3) }
        : { frame: undefined, ref },
    offset: async () => ({ x: 100, y: 200 }),
    async evaluate(frame, expression, _s, options) {
      for (const [needle, value] of Object.entries(dom))
        if (expression.includes(needle))
          return typeof value === 'function'
            ? value(frame, options, expression)
            : value;
      throw new Error(`unexpected expression ${expression.slice(0, 40)}`);
    },
  };
  return page;
}
const run = (c, page, args, context = {}) =>
  c.pageAction(
    page,
    { evaluate: async () => 'visible' },
    args,
    'chat',
    undefined,
    context,
  );

test('upload resolves files and targets the frame session of the input', async () => {
  const state = await dir(),
    cwd = join(state, 'cwd');
  await mkdir(cwd);
  await writeFile(join(cwd, 'cv.pdf'), 'x');
  await writeFile(join(state, 'outside.txt'), 'x');
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: state,
  });
  const page = fakePage({
    dom: {
      '"fileInput"': (_frame, options) => {
        assert.equal(options.byValue, false);
        return { objectId: 'obj-1' };
      },
    },
  });
  const result = await run(
    c,
    page,
    { action: 'upload', ref: 'f1:r1-1', files: ['cv.pdf'] },
    { cwd },
  );
  assert.deepEqual(result, { uploaded: 1, files: ['cv.pdf'] });
  const set = page.calls.find((x) => x.method === 'DOM.setFileInputFiles');
  assert.equal(set.params.objectId, 'obj-1');
  assert.equal(set.sessionId, 'child');
  assert.match(set.params.files[0], /cv\.pdf$/);
  await assert.rejects(
    run(
      c,
      page,
      { action: 'upload', ref: 'r', files: [join(state, 'outside.txt')] },
      { cwd },
    ),
    /limited to files/,
  );
  c.dispose();
});
test('element screenshots clip to the element in page coordinates', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage({
    dom: { '"rect"': { x: 10, y: 20, width: 30, height: 40 } },
    handlers: {
      'Page.getLayoutMetrics': () => ({
        cssLayoutViewport: { pageX: 5, pageY: 500 },
        cssContentSize: { width: 1000, height: 30000 },
      }),
      'Page.captureScreenshot': () => ({ data: 'aGk=' }),
    },
  });
  const shot = await run(c, page, {
    action: 'screenshot',
    tabId: 't',
    ref: 'r1',
  });
  assert.equal(shot.mediaType, 'image/png');
  const capture = page.calls.find((x) => x.method === 'Page.captureScreenshot');
  assert.deepEqual(capture.params, {
    format: 'png',
    clip: { x: 15, y: 520, width: 30, height: 40, scale: 1 },
  });
  const full = await run(c, page, {
    action: 'screenshot',
    tabId: 't2',
    fullPage: true,
  });
  assert.equal(full.clipped, true);
  const second = page.calls.filter(
    (x) => x.method === 'Page.captureScreenshot',
  )[1];
  assert.equal(second.params.captureBeyondViewport, true);
  assert.deepEqual(second.params.clip, {
    x: 0,
    y: 0,
    width: 1000,
    height: 16384,
    scale: 1,
  });
  await assert.rejects(
    run(c, page, {
      action: 'screenshot',
      tabId: 't',
      ref: 'r',
      fullPage: true,
    }),
    /either fullPage/,
  );
  c.dispose();
});
test('networkidle waits for load and for requests already in flight', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  let state = 'interactive';
  const page = fakePage({ dom: { 'document.readyState': () => state } });
  page.context.inflight = new Map([['started-before-wait', 'https://x/a']]);
  const started = Date.now();
  const waiting = run(c, page, {
    action: 'wait',
    condition: 'networkidle',
    timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 150));
  state = 'complete';
  await new Promise((r) => setTimeout(r, 150));
  page.context.inflight.delete('started-before-wait');
  assert.deepEqual(await waiting, { matched: true });
  assert.ok(Date.now() - started >= 750, 'load, then 500 ms of quiet');
  const stuck = fakePage({ dom: { 'document.readyState': 'complete' } });
  stuck.context.inflight = new Map([['poll', 'https://x/poll']]);
  const result = await run(c, stuck, {
    action: 'wait',
    condition: 'networkidle',
    timeoutMs: 200,
  });
  assert.equal(result.code, 'WAIT_TIMEOUT');
  assert.equal(result.pendingRequests, 1);
  assert.deepEqual(result.pending, ['https://x/poll']);
  c.dispose();
});
test('downloads stream from the page in chunks into the chat downloads folder', async () => {
  const state = await dir();
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: state,
  });
  const page = fakePage({
    dom: {
      '"href"': { url: 'https://site.test/files/report.pdf' },
      'async function inPageFetch': {
        size: 5,
        type: 'application/pdf',
        url: 'https://site.test/files/report.pdf',
      },
      'async function readChunk': Buffer.from('%PDF!').toString('base64'),
      delete: true,
    },
  });
  const result = await run(c, page, {
    action: 'download',
    tabId: 't',
    ref: 'r1',
  });
  assert.equal(result.bytes, 5);
  assert.match(result.path, /report\.pdf$/);
  assert.ok(result.path.startsWith(join(state, 'downloads')));
  assert.equal(await readFile(result.path, 'utf8'), '%PDF!');
  c.dispose();
});
test('a download the page cannot fetch fails with guidance instead of fetching host-side', async () => {
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: await dir(),
  });
  const page = fakePage({
    dom: {
      'async function inPageFetch': { error: 'Failed to fetch' },
      'location.href': ['https://site.test/', 'UA'],
    },
  });
  await assert.rejects(
    run(c, page, {
      action: 'download',
      tabId: 't',
      url: 'http://127.0.0.1:9/x',
    }),
    /cannot be downloaded/,
  );
  await assert.rejects(
    run(c, page, { action: 'download', tabId: 't', url: 'file:///etc/passwd' }),
    /HTTP/,
  );
  c.dispose();
});
test('hidden native tabs report TAB_HIDDEN without attempting a capture', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage();
  const calls = [];
  const invoke = async (method, ...params) => {
    calls.push([method, ...params]);
    return { native: true, visible: false };
  };
  const result = await c.pageAction(
    page,
    { evaluate: async () => 'visible' },
    { action: 'screenshot', tabId: 'n1' },
    'chat',
    undefined,
    {},
    invoke,
  );
  assert.equal(result.code, 'TAB_HIDDEN');
  assert.equal(page.calls.length, 0);
  assert.equal(c.screenshots.blocked.size, 0, 'later captures are not blocked');
  c.dispose();
});
test('parked plugin tabs are raised for the capture and restored afterwards', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const order = [];
  const page = fakePage({
    handlers: {
      'Page.captureScreenshot': () => (order.push('capture'), { data: 'aGk=' }),
    },
  });
  const invoke = async (method, tabId, active) => {
    order.push(`surface:${active}`);
    return { native: false, visible: false, raised: true };
  };
  const result = await c.pageAction(
    page,
    { evaluate: async () => 'visible' },
    { action: 'screenshot', tabId: 'p1' },
    'chat',
    undefined,
    {},
    invoke,
  );
  assert.equal(result.data, 'aGk=');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['surface:true', 'capture', 'surface:false']);
  c.dispose();
});
test('multi-chunk page downloads are appended to disk in order', async () => {
  const state = await dir();
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: state,
  });
  const chunk = 4 * 1024 * 1024;
  const page = fakePage({
    dom: {
      'async function inPageFetch': {
        size: chunk + 3,
        url: 'https://site.test/big.bin',
      },
      'async function readChunk': (_frame, _o, expression) =>
        Buffer.from(expression.includes(`,0,`) ? 'A' : 'B').toString('base64'),
      delete: true,
    },
  });
  const result = await run(c, page, {
    action: 'download',
    tabId: 't',
    url: 'https://site.test/big.bin',
  });
  assert.equal(await readFile(result.path, 'utf8'), 'AB');
  assert.equal(result.bytes, 2);
  c.dispose();
});
test('drag completes native HTML5 drags and plain mouse drags', async () => {
  for (const html5 of [true, false]) {
    const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
    const page = fakePage({ dom: { '"point"': { x: 10, y: 20 } } });
    const call = page.call.bind(page);
    let pressed = false;
    page.call = async (method, params, s, sid) => {
      if (
        method === 'Input.dispatchMouseEvent' &&
        params.type === 'mousePressed'
      )
        pressed = true;
      if (
        html5 &&
        pressed &&
        method === 'Input.dispatchMouseEvent' &&
        params.type === 'mouseMoved'
      )
        page.emit('Input.dragIntercepted', { data: { items: [] } });
      return call(method, params, s, sid);
    };
    const result = await run(c, page, {
      action: 'drag',
      tabId: 't',
      ref: 'r1.1',
      toX: 300,
      toY: 200,
    });
    const methods = page.calls.map((x) => `${x.method}:${x.params.type ?? ''}`);
    assert.equal(result.html5, html5 || undefined);
    assert.equal(
      methods.filter((m) => m.startsWith('Input.dispatchDragEvent')).length,
      html5 ? 3 : 0,
    );
    const drop = page.calls.find((x) => x.params.type === 'drop');
    if (html5) assert.deepEqual([drop.params.x, drop.params.y], [300, 200]);
    assert.ok(methods.includes('Input.dispatchMouseEvent:mouseReleased'));
    assert.equal(page.calls.at(-1).params.enabled, false, 'interception off');
    c.dispose();
  }
});
test('plugin tabs load only after logging is attached', async () => {
  for (const attachFails of [false, true]) {
    const order = [];
    const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
    c.targets = async () => [
      { id: 'app', type: 'page', url: 'dsh-app://app/' },
    ];
    const { BUILD } = await import('../src/compatibility.js');
    c.connection = async () => ({
      async evaluate(expression) {
        if (expression.includes('status?.()'))
          return { version: 2, build: BUILD };
        const [, method, args] = /api\["(\w+)"\]\(\.\.\.(\[.*\])\)/.exec(
          expression,
        );
        order.push([method, ...JSON.parse(args).slice(1)]);
        if (method === 'open')
          return { tabId: 't1', background: true, pendingLoad: true };
        if (method === 'lease') return 'lease-1';
        return {};
      },
    });
    c.locate = async () => {
      order.push(['attach']);
      if (attachFails) throw new Error('target not found');
      return {
        on: () => () => {},
        call: async () => ({ frameTree: { frame: { id: 'm' } } }),
      };
    };
    const result = await c.run(
      { action: 'open', url: 'https://x.test/' },
      'chat',
    );
    assert.deepEqual(result, { tabId: 't1', background: true });
    assert.deepEqual(order, [
      ['open', 'https://x.test/', true, { deferLoad: true }],
      ['lease', 't1'],
      ['attach'],
      ['load', 't1'],
    ]);
    c.dispose();
  }
});
