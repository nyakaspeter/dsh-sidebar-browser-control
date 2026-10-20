import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { CDP, endpoint, website } from '../src/cdp.js';
import { apply } from '../src/index.js';

test('restricts debugging transport to loopback and navigation to HTTP(S)', () => {
  for (const value of [
    'http://example.com:9222',
    'http://127.0.0.1:9222/path',
    'https://127.0.0.1:9222',
    'http://u:p@127.0.0.1:9222',
  ])
    assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://127.0.0.1:41234/'), 'http://127.0.0.1:41234');
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://u:p@example.com',
  ])
    assert.throws(() => website(url));
  assert.equal(website('https://example.com'), 'https://example.com/');
});
test('CDP propagates errors, collects events, and cancels requests', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  server.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'hang') return;
      ws.send(
        JSON.stringify({
          method: 'Log.entryAdded',
          params: { entry: { text: 'test' } },
        }),
      );
      ws.send(
        JSON.stringify(
          m.method === 'bad'
            ? { id: m.id, error: { message: 'rejected' } }
            : { id: m.id, result: { result: { value: 42 } } },
        ),
      );
    }),
  );
  const c = await CDP.connect(base.replace('http:', 'ws:'), base);
  try {
    assert.equal(await c.evaluate('21*2'), 42);
    assert.equal(c.events.length, 0);
    c.recording = true;
    await assert.rejects(c.call('bad'), /rejected/);
    const abort = new AbortController();
    const pending = c.call('hang', {}, abort.signal);
    abort.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
    assert.equal(c.pending.size, 0);
  } finally {
    c.close();
    await new Promise((r) => server.close(r));
  }
});
test('tool validates action and requires a live agent', async () => {
  let tool;
  const cleanup = [];
  apply({
    effect: (fn) => cleanup.push(fn()),
    tools: { register: (t) => (tool = t) },
  });
  try {
    assert.equal(tool.name, 'sidebar_browser');
    assert.doesNotMatch(tool.description, /cookie/i);
    await assert.rejects(
      tool.execute(
        { action: 'list' },
        { signal: new AbortController().signal },
      ),
      /live DSH chat/,
    );
    await assert.rejects(
      tool.execute(
        { action: 'invalid' },
        { signal: new AbortController().signal },
      ),
      /action/,
    );
  } finally {
    cleanup.forEach((f) => f());
  }
});

test('status reports plugin updates only while the setting is on', async () => {
  const { SidebarController } = await import('../src/controller.js');
  const { UpdateChecker } = await import('../src/updates.js');
  const run = SidebarController.prototype.run,
    check = UpdateChecker.prototype.check;
  SidebarController.prototype.run = async () => ({ ok: true });
  UpdateChecker.prototype.check = async () => ({ available: false });
  try {
    let enabled = true,
      tool;
    const cleanup = [];
    apply(
      {
        effect: (fn) => cleanup.push(fn()),
        tools: { register: (t) => (tool = t) },
      },
      { checkForUpdates: { get: () => enabled } },
    );
    try {
      const status = async () =>
        JSON.parse(
          await tool.execute({ action: 'status' }, { agent: { id: 'test' } }),
        );
      assert.deepEqual((await status()).update, { available: false });
      enabled = false;
      assert.equal((await status()).update, undefined);
      assert.equal((await status()).cookieConsent, undefined);
    } finally {
      cleanup.forEach((f) => f());
    }
  } finally {
    SidebarController.prototype.run = run;
    UpdateChecker.prototype.check = check;
  }
});
