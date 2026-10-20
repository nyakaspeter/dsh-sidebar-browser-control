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
    assert.match(tool.description, /reject optional cookies/);
    assert.match(tool.description, /preserve existing choices/);
    assert.match(tool.description, /max 6 consent interactions/);
    assert.match(tool.description, /Never accept all/);
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

test('cookie consent setting is live and defaults to enabled', async () => {
  const { SidebarController } = await import('../src/controller.js');
  const original = SidebarController.prototype.run;
  SidebarController.prototype.run = async () => ({});
  try {
    for (const [config, enabled] of [
      [undefined, true],
      [{ autoCookieConsent: true }, true],
      [{ autoCookieConsent: false }, false],
    ]) {
      let tool;
      const cleanup = [];
      apply(
        {
          effect: (fn) => cleanup.push(fn()),
          tools: { register: (t) => (tool = t) },
        },
        config,
      );
      try {
        const result = JSON.parse(
          await tool.execute({ action: 'status' }, { agent: { id: 'test' } }),
        );
        assert.equal(result.cookieConsent.enabled, enabled);
      } finally {
        cleanup.forEach((f) => f());
      }
    }
    let enabled = true,
      tool;
    const cleanup = [];
    apply(
      {
        effect: (fn) => cleanup.push(fn()),
        tools: { register: (t) => (tool = t) },
      },
      { autoCookieConsent: { get: () => enabled } },
    );
    try {
      for (const value of [true, false, true]) {
        enabled = value;
        const result = JSON.parse(
          await tool.execute(
            { action: 'read', tabId: 'test' },
            { agent: { id: 'test' } },
          ),
        );
        assert.equal(result.cookieConsent.enabled, value);
      }
    } finally {
      cleanup.forEach((f) => f());
    }
  } finally {
    SidebarController.prototype.run = original;
  }
});
