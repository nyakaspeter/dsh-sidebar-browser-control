import assert from 'node:assert/strict';
import http from 'node:http';
import { SidebarController } from '../src/controller.js';
const sessions = process.argv.slice(2);
if (sessions.length !== 2) throw Error('Provide two loaded session IDs');
const server = http.createServer((req, res) =>
  res.end('<title>Queue fixture</title><p>Ready</p>'),
);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const c = new SidebarController(),
  tabs = [];
try {
  for (const s of sessions) {
    const t = await c.run(
      { action: 'open', url: `http://127.0.0.1:${server.address().port}/` },
      s,
    );
    tabs.push(t.tabId);
    await c.run(
      { action: 'wait', tabId: t.tabId, condition: 'text', text: 'Ready' },
      s,
    );
  }
  let settled = false;
  const slow = c
    .run(
      {
        action: 'wait',
        tabId: tabs[0],
        condition: 'text',
        text: 'never',
        timeoutMs: 3000,
      },
      sessions[0],
    )
    .then((r) => {
      settled = true;
      return r;
    });
  await new Promise((r) => setTimeout(r, 100));
  const start = performance.now();
  const read = await c.run({ action: 'read', tabId: tabs[1] }, sessions[1]);
  const elapsed = performance.now() - start;
  assert.ok(read.text.includes('Ready'));
  assert.equal(settled, false);
  assert.ok(elapsed < 2000);
  assert.equal((await slow).code, 'WAIT_TIMEOUT');
  console.log(
    `PASS: chat B read completed in ${Math.round(elapsed)} ms during chat A's 3-second wait.`,
  );
} finally {
  for (let i = 0; i < tabs.length; i++)
    await c.run({ action: 'close', tabId: tabs[i] }, sessions[i]);
  c.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
