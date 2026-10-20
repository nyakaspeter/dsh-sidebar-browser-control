// Live checks through the tool interface: isolated worlds, main-content reads,
// find, cross-origin frames, uploads, downloads, screenshot modes, network
// idle, logs and HTML5 drag-and-drop. Requires a visible chat.
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
  if (req.url === '/api/items') {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"items":[1,2]}');
    return;
  }
  if (req.url === '/slow') {
    setTimeout(() => res.end('ok'), 600);
    return;
  }
  if (req.url === '/missing') {
    res.statusCode = 404;
    res.end('nope');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Feature fixture</title><style>body{height:2200px}#h5,#h5drop{width:80px;height:40px;background:#ccc}</style>
<nav><a href="/nav-only">Navigation only link</a> Navigation text</nav>
<main><p id="intro">Feature fixture main content. ${'Readable article text. '.repeat(20)}</p>
<a id="dl" href="/file.txt">Fixture file</a>
<input type="file" id="file" multiple onchange="document.querySelector('#files').textContent=[...this.files].map(f=>f.name).join(',')">
<p id="files">none</p>
<div id="h5" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','payload')">Drag me</div>
<div id="h5drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();window.dropped=event.dataTransfer.getData('text/plain')">Drop here</div>
<iframe src="http://127.0.0.1:${framePort}/same-site" width="300" height="80"></iframe>
<iframe src="http://localhost:${framePort}/cross-site" width="300" height="80"></iframe></main>
<footer>Footer text</footer>
<script>
// A hostile page patching DOM APIs must not affect plugin reads.
Element.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 });
window.__dshBrowserElements = 'page-owned';
fetch('/missing');
console.error('fixture console error');
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
  // Reads, finds and logs are plain text; other results are JSON.
  const run = async (args) => {
    const out = await tool.execute(
      { ...(tab ? { tabId: tab.tabId } : {}), ...args },
      { agent: { id: session }, signal: new AbortController().signal },
    );
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  };
  const refOf = (text, label) =>
    new RegExp(`^(\\S+) \\S+ ${JSON.stringify(label)}`, 'm').exec(text)?.[1];

  tab = await run({ action: 'open', url: base });
  await run({ action: 'wait', mode: 'ready' });
  const idle = await run({ action: 'wait', mode: 'networkidle' });
  assert.equal(idle.matched, true, 'network idle: ' + JSON.stringify(idle));

  // Main-content reads skip navigation/footer text but list all controls.
  const snap = await run({ action: 'read', full: true });
  assert.match(snap, /text: main content only/);
  assert.ok(snap.includes('Readable article text'));
  assert.ok(!snap.includes('Footer text') && !snap.includes('Navigation text'));
  assert.ok(refOf(snap, 'Navigation only link'), 'nav controls still listed');
  assert.ok(refOf(snap, 'Fixture file'), 'isolated world ignores page patches');

  for (const name of ['same-site', 'cross-site']) {
    const ref = refOf(snap, `Cross frame /${name}`);
    assert.match(ref ?? '', /^f\d+:r\d+\.\d+$/, `${name} frame ref`);
    await run({ action: 'click', target: ref });
  }
  const after = await run({ action: 'read', mode: 'page' });
  assert.ok(after.includes('Footer text'), 'mode page reads everything');
  for (const name of ['same-site', 'cross-site'])
    assert.ok(after.includes(`Clicked /${name}`), `${name} frame click landed`);
  assert.equal(
    await run({ action: 'evaluate', text: 'window.__dshBrowserElements' }),
    'page-owned',
    'plugin refs never touch the page global',
  );

  const found = await run({ action: 'find', text: 'fixture file' });
  assert.match(
    found,
    /^Found 1 for "fixture file":\n\S+ link "Fixture file" → \/file\.txt$/,
  );

  // Logs are captured from the very first load and shown incrementally.
  const problems = await run({ action: 'logs' });
  assert.match(problems, /\[error\] fixture console error/);
  assert.match(problems, /#\d+ GET 404 fetch .*\/missing/);
  assert.match(await run({ action: 'logs' }), /Failed requests: none\./);
  await run({
    action: 'evaluate',
    text: 'fetch("/api/items").then(r=>r.text())',
  });
  await new Promise((r) => setTimeout(r, 200));
  const requests = await run({
    action: 'logs',
    mode: 'requests',
    text: 'api/items',
  });
  const number = /#(\d+) GET 200 fetch/.exec(requests)?.[1];
  assert.ok(number, requests);
  assert.match(
    await run({ action: 'logs', text: `#${number}` }),
    /content-type: application\/json\nresponse body:\n\{"items":\[1,2\]\}/,
  );

  const drop = await run({ action: 'drag', target: '#h5', text: '#h5drop' });
  assert.equal(drop.html5, true, JSON.stringify(drop));
  assert.equal(
    await run({ action: 'evaluate', text: 'window.dropped' }),
    'payload',
  );

  const download = await run({
    action: 'download',
    target: refOf(after, 'Fixture file'),
  });
  created.push(download.path);
  assert.match(download.path, /fixture\.txt$/);
  await assert.rejects(
    run({ action: 'download', url: `http://localhost:${framePort}/x` }),
    /can only fetch files its site allows/,
  );
  const big = await run({ action: 'download', url: `${base}/big.bin` });
  created.push(big.path);
  assert.equal(big.bytes, 12 * 1024 * 1024, 'multi-chunk download streamed');
  assert.equal((await stat(big.path)).size, big.bytes);
  const { readdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  assert.ok(
    !(await readdir(dirname(big.path))).some((n) => n.endsWith('.part')),
    'no partial files remain',
  );

  const upload = await run({
    action: 'upload',
    target: '#file',
    files: [download.path],
  });
  assert.equal(upload.uploaded, 1);
  assert.ok((await run({ action: 'read' })).includes('fixture.txt'));

  const pngHeight = (data) => Buffer.from(data, 'base64').readUInt32BE(20);
  const raw = (args) => c.run({ tabId: tab.tabId, ...args }, session);
  const full = await raw({ action: 'screenshot', fullPage: true });
  assert.ok(full.data, `full-page capture: ${full.reason}`);
  assert.ok(pngHeight(full.data) >= 2200, 'full page height');
  const element = await raw({ action: 'screenshot', selector: '#intro' });
  assert.ok(element.data, `element capture: ${element.reason}`);

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
