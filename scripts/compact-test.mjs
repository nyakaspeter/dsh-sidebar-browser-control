import assert from 'node:assert/strict';
import http from 'node:http';
import { SidebarController } from '../src/controller.js';
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<title>Compact read fixture</title><section id="scope"><h2>Scoped content</h2><button>Scoped button</button></section><p>' +
      'Long page text. '.repeat(4000) +
      '</p>' +
      Array.from(
        { length: 120 },
        (_, i) => `<button>Button ${i}</button>`,
      ).join(''),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const c = new SidebarController();
let s, t;
try {
  s = (await c.run({ action: 'status' }, 'test')).client.visibleSession;
  t = await c.run(
    { action: 'open', url: `http://127.0.0.1:${server.address().port}/` },
    s,
  );
  const run = (a) => c.run({ tabId: t.tabId, ...a }, s);
  await run({ action: 'wait', condition: 'text', text: 'Scoped content' });
  const first = await run({ action: 'read' });
  assert.equal(first.text.length, 6000);
  assert.equal(first.elements.length, 40);
  assert.equal(first.next, '6000,40');
  const second = await run({
    action: 'read',
    textOffset: 6000,
    elementOffset: 40,
  });
  assert.equal(second.elements[0].label, 'Button 39');
  assert.equal(second.elements.length, 40);
  await assert.rejects(
    run({ action: 'click', ref: first.elements[0].ref }),
    /Stale/,
  );
  const full = await run({ action: 'read', detail: 'full' });
  assert.equal(full.text.length, 40000);
  assert.equal(full.elements.length, 121);
  const scope = await run({ action: 'read', selector: '#scope' });
  assert.equal(scope.elements.length, 1);
  assert.ok(scope.text.includes('Scoped content'));
  assert.ok(!scope.text.includes('Long page'));
  await assert.rejects(run({ action: 'read', textOffset: -1 }), /nonnegative/);
  await run({
    action: 'evaluate',
    expression:
      'for(let i=0;i<400;i++)console.log("debug fixture "+i);console.error("fixture error");true',
  });
  await new Promise((r) => setTimeout(r, 200));
  const problems = await run({ action: 'logs', mode: 'problems' });
  assert.deepEqual(
    problems.console.map((x) => x.text),
    ['fixture error'],
  );
  const consoleLogs = await run({ action: 'logs', mode: 'console' });
  assert.equal(consoleLogs.console.length, 50, 'bounded');
  assert.equal(
    (await run({ action: 'logs', mode: 'console' })).console.length,
    0,
    'incremental',
  );
  await run({ action: 'close' });
  t = null;
  assert.equal(c.pages.size, 0);
  assert.equal(c.connections.size, 1);
  console.log(
    'PASS: compact/full/paginated/scoped reads, stale refs, bounded incremental logs, and connection cleanup.',
  );
} finally {
  if (t) await c.run({ action: 'close', tabId: t.tabId }, s);
  c.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
