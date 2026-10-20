import assert from 'node:assert/strict';
import http from 'node:http';
import { SidebarController } from '../src/controller.js';
const sessions = process.argv.slice(2);
if (sessions.length !== 2)
  throw new Error('Provide two loaded DSH session IDs');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<title>Concurrent browser fixture</title><label>Owner<input id="owner"></label><p>ISOLATION FIXTURE</p>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`,
  controllers = sessions.map(() => new SidebarController());
const tabs = [];
try {
  for (let i = 0; i < 2; i++) {
    const c = controllers[i],
      s = sessions[i];
    const tab = await c.run({ action: 'open', url: base }, s);
    assert.ok(tab.tabId, JSON.stringify(tab));
    tabs[i] = tab;
    await c.run(
      {
        action: 'wait',
        tabId: tab.tabId,
        condition: 'text',
        text: 'ISOLATION FIXTURE',
      },
      s,
    );
    await c.run(
      {
        action: 'type',
        tabId: tab.tabId,
        selector: '#owner',
        text: `owner-${i}`,
      },
      s,
    );
  }
  console.log(
    'READY: switch chats, hide or minimize DSH during the next 25 seconds.',
  );
  for (let round = 0; round < 25; round++) {
    await Promise.all(
      controllers.map(async (c, i) => {
        const s = sessions[i],
          tabId = tabs[i].tabId;
        assert.equal(
          await c.run(
            {
              action: 'evaluate',
              tabId,
              expression: 'document.querySelector("#owner").value',
            },
            s,
          ),
          `owner-${i}`,
        );
        const temporary = await c.run(
          { action: 'open', url: base + '/?temporary=' + round },
          s,
        );
        assert.ok(temporary.tabId);
        await c.run({ action: 'close', tabId: temporary.tabId }, s);
        await assert.rejects(
          c.run({ action: 'read', tabId: tabs[1 - i].tabId }, s),
          /another chat|Unknown tab/,
        );
        if (round === 10) {
          const image = await c.run({ action: 'screenshot', tabId }, s);
          assert.ok(image.data || image.code === 'SCREENSHOT_UNAVAILABLE');
          console.log(
            `Screenshot ${i}: ${image.data ? 'captured' : image.code}`,
          );
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(
    'PASS: concurrent page state isolated; background open/close and cross-chat access rejection.',
  );
} finally {
  await Promise.all(
    controllers.map(async (c, i) => {
      try {
        if (tabs[i])
          await c.run({ action: 'close', tabId: tabs[i].tabId }, sessions[i]);
      } finally {
        c.dispose();
      }
    }),
  );
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
