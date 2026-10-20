// Live checks for isolated worlds, cross-origin frames, uploads, downloads,
// screenshot modes, network idle and the cdp policy. Requires a visible chat.
import assert from 'node:assert/strict';
import http from 'node:http';
import { rm, stat } from 'node:fs/promises';
import { apply } from '../src/index.js';
import { SidebarController } from '../src/controller.js';

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
const frames = await listen((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><button id="b" onclick="this.textContent='Clicked ${req.url}'">Cross frame ${req.url}</button>`,
  );
});
const framePort = frames.address().port;
const main = await listen((req, res) => {
  if (req.url === '/file.txt') {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
    res.end('downloaded content');
    return;
  }
  if (req.url === '/big.bin') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(Buffer.alloc(12 * 1024 * 1024, 7));
    return;
  }
  if (req.url === '/slow') {
    setTimeout(() => res.end('ok'), 600);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Feature fixture</title><style>body{height:2200px}</style>
<p id="intro">Feature fixture</p>
<a id="dl" href="/file.txt">Fixture file</a>
<input type="file" id="file" multiple onchange="document.querySelector('#files').textContent=[...this.files].map(f=>f.name).join(',')">
<p id="files">none</p>
<iframe src="http://127.0.0.1:${framePort}/same-site" width="300" height="80"></iframe>
<iframe src="http://localhost:${framePort}/cross-site" width="300" height="80"></iframe>
<script>
// A hostile page patching DOM APIs must not affect plugin reads.
Element.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 });
window.__dshBrowserElements = 'page-owned';
addEventListener('load', () => setTimeout(() => fetch('/slow'), 50));
</script>`);
});
const base = `http://127.0.0.1:${main.address().port}`;
const c = new SidebarController();
let session, tab, tool;
const cleanups = [],
  created = [];
try {
  const status = await c.run({ action: 'status' }, 'test');
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.client.diagnostics.warnings, []);
  session = status.client.visibleSession;
  apply({
    effect: (fn) => cleanups.push(fn()),
    tools: { register: (t) => (tool = t) },
  });
  const run = async (args) =>
    JSON.parse(
      await tool.execute(
        { ...(tab ? { tabId: tab.tabId } : {}), ...args },
        { agent: { id: session }, signal: new AbortController().signal },
      ),
    );
  tab = await run({ action: 'open', url: base });
  await run({ action: 'wait', condition: 'ready' });
  const idle = await run({
    action: 'wait',
    condition: 'networkidle',
    timeoutMs: 5000,
  });
  assert.equal(idle.matched, true, 'network idle after the slow request');

  const snap = await run({ action: 'read', detail: 'full' });
  assert.ok(
    snap.elements.some((e) => e.label === 'Fixture file'),
    'isolated world ignores page monkeypatching',
  );
  for (const name of ['same-site', 'cross-site']) {
    const button = snap.elements.find(
      (e) => e.label === `Cross frame /${name}`,
    );
    assert.ok(
      button,
      `${name} frame is readable: ${JSON.stringify(snap.inaccessibleFrames)}`,
    );
    assert.match(button.ref, /^f\d+:/);
    await run({ action: 'click', ref: button.ref });
  }
  const after = await run({ action: 'read', detail: 'full' });
  for (const name of ['same-site', 'cross-site'])
    assert.ok(
      after.text.includes(`Clicked /${name}`),
      `${name} frame click landed`,
    );
  assert.equal(
    await run({
      action: 'evaluate',
      expression: 'window.__dshBrowserElements',
    }),
    'page-owned',
    'plugin refs never touch the page global',
  );

  const link = after.elements.find((e) => e.label === 'Fixture file');
  const download = await run({ action: 'download', ref: link.ref });
  created.push(download.path);
  assert.equal(download.via, 'page');
  assert.match(download.path, /fixture\.txt$/);
  await assert.rejects(
    run({ action: 'download', url: `http://localhost:${framePort}/x` }),
    /private or local/,
    'CORS-blocked local download is refused host-side',
  );

  const big = await run({ action: 'download', url: `${base}/big.bin` });
  created.push(big.path);
  assert.equal(big.bytes, 12 * 1024 * 1024, 'multi-chunk download streamed');
  assert.equal((await stat(big.path)).size, big.bytes);

  const input = after.elements.find((e) => e.type === 'file');
  const upload = await run({
    action: 'upload',
    ref: input.ref,
    files: [download.path],
  });
  assert.equal(upload.uploaded, 1);
  assert.ok(
    (await run({ action: 'read' })).text.includes('fixture.txt'),
    'page received the uploaded file',
  );

  const pngHeight = (data) => Buffer.from(data, 'base64').readUInt32BE(20);
  const raw = (args) => c.run({ tabId: tab.tabId, ...args }, session);
  const full = await raw({ action: 'screenshot', fullPage: true });
  assert.ok(full.data, `full-page capture: ${full.reason}`);
  assert.ok(pngHeight(full.data) >= 2200, 'full page height');
  const element = await raw({ action: 'screenshot', selector: '#intro' });
  assert.ok(element.data, `element capture: ${element.reason}`);
  assert.ok(pngHeight(element.data) < 100, 'element clip');

  // A native DSH tab that is not on screen cannot be drawn or captured.
  const native = await run({ action: 'open', url: base, background: false });
  try {
    assert.equal(native.native, true);
    await run({ action: 'hide', tabId: native.tabId });
    const hidden = await c.run(
      { action: 'screenshot', tabId: native.tabId },
      session,
    );
    assert.equal(hidden.code, 'TAB_HIDDEN', JSON.stringify(hidden));
  } finally {
    await run({ action: 'close', tabId: native.tabId }).catch(() => {});
  }

  await assert.rejects(
    run({
      action: 'cdp',
      method: 'Page.navigate',
      params: JSON.stringify({ url: 'file:///etc/hosts' }),
    }),
    /navigate action/,
  );
  await assert.rejects(
    run({ action: 'cdp', method: 'Network.getAllCookies' }),
    /not permitted/,
  );
  console.log('Feature checks passed');
} finally {
  if (tab && tool)
    await tool
      .execute(
        { action: 'close', tabId: tab.tabId },
        { agent: { id: session }, signal: new AbortController().signal },
      )
      .catch(() => {});
  for (const path of created) await rm(path, { force: true });
  cleanups.forEach((f) => f?.());
  c.dispose();
  main.close();
  frames.close();
}
