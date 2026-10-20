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

test('multi-window routing picks the window that shows the calling chat', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const windows = {
    w1: { loaded: true, visible: false },
    w2: { loaded: true, visible: true },
    w3: null,
  };
  c.connection = async (t) => ({ evaluate: async () => windows[t.id] });
  const apps = Object.keys(windows).map((id) => ({
    id,
    type: 'page',
    url: 'dsh-app://app/',
  }));
  assert.equal((await c.windowFor(apps, 'chat')).id, 'w2');
  windows.w2 = null;
  c.windows.clear();
  assert.equal((await c.windowFor(apps, 'chat')).id, 'w1');
  windows.w1 = null;
  c.windows.clear();
  await assert.rejects(
    c.windowFor(apps, 'chat'),
    /not loaded in any DSH window/,
  );
  c.dispose();
});
test('raw cdp commands pass the policy before reaching the page', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage();
  await assert.rejects(
    run(c, page, {
      action: 'cdp',
      method: 'Page.navigate',
      params: '{"url":"file:///etc/passwd"}',
    }),
    /navigate action/,
  );
  assert.equal(page.calls.length, 0);
  await run(c, page, {
    action: 'cdp',
    method: 'DOM.getDocument',
    params: '{}',
  });
  assert.equal(page.calls[0].method, 'DOM.getDocument');
  c.dispose();
});
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
    format: 'jpeg',
    quality: 50,
  });
  assert.equal(shot.mediaType, 'image/jpeg');
  const capture = page.calls.find((x) => x.method === 'Page.captureScreenshot');
  assert.deepEqual(capture.params, {
    format: 'jpeg',
    quality: 50,
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
test('networkidle waits for in-flight main-frame requests to finish', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage();
  const waiting = run(c, page, {
    action: 'wait',
    condition: 'networkidle',
    timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 20));
  page.emit('Network.requestWillBeSent', { requestId: '1', type: 'XHR' });
  await new Promise((r) => setTimeout(r, 300));
  page.emit('Network.loadingFinished', { requestId: '1' });
  const started = Date.now();
  assert.deepEqual(await waiting, { matched: true });
  assert.ok(Date.now() - started >= 450, 'waited for 500 ms of quiet');
  assert.ok(page.calls.some((x) => x.method === 'Network.disable'));
  const stuck = fakePage();
  const pending = run(c, stuck, {
    action: 'wait',
    condition: 'networkidle',
    timeoutMs: 200,
  });
  await new Promise((r) => setTimeout(r, 10));
  stuck.emit('Network.requestWillBeSent', { requestId: 'poll', type: 'Fetch' });
  const result = await pending;
  assert.equal(result.code, 'WAIT_TIMEOUT');
  assert.equal(result.pendingRequests, 1);
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
  assert.equal(result.via, 'page');
  assert.equal(result.bytes, 5);
  assert.match(result.path, /report\.pdf$/);
  assert.ok(result.path.startsWith(join(state, 'downloads')));
  assert.equal(await readFile(result.path, 'utf8'), '%PDF!');
  c.dispose();
});
test('a CORS-blocked download falls back to the host and refuses local addresses', async () => {
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
    /private or local/,
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
