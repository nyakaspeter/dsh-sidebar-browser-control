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
    watchNavigation: () => ({ settle: async () => null, dispose() {} }),
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
const main = { evaluate: async () => 'visible' };
const run = (c, page, args, context = {}, invoke = async () => null) =>
  c.pageAction(page, args, { main, session: 'chat', context, invoke });

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
        type: 'application/pdf',
        url: 'https://site.test/files/report.pdf',
      },
      'async function readChunk': {
        data: Buffer.from('%PDF!').toString('base64'),
        done: true,
      },
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
    /can only fetch files its site allows/,
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
  const result = await run(
    c,
    page,
    { action: 'screenshot', tabId: 'n1' },
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
  const result = await run(
    c,
    page,
    { action: 'screenshot', tabId: 'p1' },
    {},
    invoke,
  );
  assert.equal(result.data, 'aGk=');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['surface:true', 'capture', 'surface:false']);
  c.dispose();
});
test('page download streams are appended to disk until done', async () => {
  const state = await dir();
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: state,
  });
  const chunks = ['A', 'B', ''];
  let cleaned = false;
  const page = fakePage({
    dom: {
      'async function inPageFetch': { url: 'https://site.test/big.bin' },
      'async function readChunk': () => {
        const next = chunks.shift();
        return {
          data: Buffer.from(next).toString('base64'),
          done: !chunks.length,
        };
      },
      delete: () => {
        cleaned = true;
      },
    },
  });
  const result = await run(c, page, {
    action: 'download',
    tabId: 't',
    url: 'https://site.test/big.bin',
  });
  assert.equal(await readFile(result.path, 'utf8'), 'AB');
  assert.equal(result.bytes, 2);
  await new Promise((r) => setImmediate(r));
  assert.ok(cleaned, 'the page stream is released');
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
        if (expression.includes('status?.()')) return { build: BUILD };
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
test('a download that fails midway leaves no partial file', async () => {
  const state = await dir();
  const c = new SidebarController({
    endpoint: 'http://127.0.0.1:1',
    stateDir: state,
  });
  let reads = 0;
  const page = fakePage({
    dom: {
      'async function inPageFetch': { url: 'https://site.test/big.bin' },
      'async function readChunk': () => {
        if (reads++) throw new Error('network error');
        return { data: Buffer.from('partial').toString('base64') };
      },
      delete: true,
    },
  });
  await assert.rejects(
    run(c, page, {
      action: 'download',
      tabId: 't',
      url: 'https://site.test/big.bin',
    }),
    /network error/,
  );
  const { readdir } = await import('node:fs/promises');
  const [folder] = await readdir(join(state, 'downloads'));
  assert.deepEqual(await readdir(join(state, 'downloads', folder)), []);
  c.dispose();
});
test('clicks in out-of-process frames go to that frame session', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage({ dom: { '"point"': { x: 10, y: 20 } } });
  page.context.sessions = new Map([['child', { targetId: 'child-root' }]]);
  page.context.offset = async (frame) =>
    frame.oopif ? { x: 50, y: 60 } : { x: 100, y: 200 };
  await run(c, page, { action: 'click', tabId: 't', ref: 'f1:r1.1' });
  const presses = page.calls.filter(
    (x) => x.method === 'Input.dispatchMouseEvent',
  );
  assert.ok(presses.length);
  for (const press of presses) {
    assert.equal(press.sessionId, 'child');
    assert.deepEqual([press.params.x, press.params.y], [60, 160]);
    assert.equal(press.params.session, undefined);
  }
  c.dispose();
});
test('insert and contenteditable fill type through the guest webview', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const scripts = [];
  const guest = { evaluate: async (expression) => scripts.push(expression) };
  for (const [mode, dom] of [
    ['insert', { '"focus"': { focused: true } }],
    ['fill', { '"type"': { insert: true } }],
  ]) {
    const page = fakePage({ dom });
    const result = await c.pageAction(
      page,
      { action: 'type', tabId: 't', ref: 'r1.1', mode, text: 'héllo "x"' },
      { main: guest, session: 'chat' },
    );
    assert.deepEqual(result, { updated: true });
  }
  assert.equal(scripts.length, 2);
  for (const script of scripts)
    assert.ok(script.includes('view.insertText("héllo \\"x\\"")'));
  c.dispose();
});
test('clicks report the navigation they start once it has loaded', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage({ dom: { '"point"': { x: 1, y: 2 } } });
  let disposed = false;
  page.context.watchNavigation = () => ({
    settle: async (timeoutMs) => {
      assert.equal(timeoutMs, 3000);
      return { url: 'https://x.test/next', loaded: true };
    },
    dispose: () => (disposed = true),
  });
  const result = await run(c, page, {
    action: 'click',
    tabId: 't',
    ref: 'r1.1',
    timeoutMs: 3000,
  });
  assert.deepEqual(result, {
    click: true,
    navigation: { url: 'https://x.test/next', loaded: true },
  });
  assert.ok(disposed);
  page.context.watchNavigation = () => ({
    settle: async () => null,
    dispose() {},
  });
  assert.deepEqual(
    await run(c, page, { action: 'click', tabId: 't', ref: 'r1.1' }),
    { click: true },
  );
  c.dispose();
});
test('find continues into cross-origin frames with frame-qualified refs', async () => {
  const c = new SidebarController({ endpoint: 'http://127.0.0.1:1' });
  const page = fakePage({
    dom: {
      '"find"': (frame) =>
        frame
          ? {
              url: frame.url,
              found: [{ ref: 'r2.1', kind: 'button', label: 'Pay' }],
            }
          : { url: 'https://shop.test/', found: [], inaccessible: true },
    },
  });
  page.context.sessions = new Map();
  page.context.isolatedFrames = async () => [
    { frameId: 'pay', url: 'https://pay.test/' },
  ];
  page.context.register = () => 'f1';
  assert.deepEqual(
    await run(c, page, { action: 'find', tabId: 't', query: 'pay' }),
    {
      url: 'https://shop.test/',
      found: [{ ref: 'f1:r2.1', kind: 'button', label: 'Pay' }],
    },
  );
  c.dispose();
});
