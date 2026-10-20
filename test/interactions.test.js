import test from 'node:test';
import assert from 'node:assert/strict';
import { interact, keySpec } from '../src/interactions.js';
test('keyboard input releases keys even when cancelled during a hold', async () => {
  const abort = new AbortController(),
    events = [];
  const page = {
    call: async (method, params) => {
      events.push({ method, ...params });
      if (params.type === 'keyDown') abort.abort(new Error('cancelled'));
    },
  };
  await assert.rejects(
    interact(
      page,
      { action: 'press', key: 'ArrowRight', durationMs: 1000 },
      abort.signal,
    ),
  );
  assert.equal(events.at(-1).type, 'keyUp');
  assert.equal(events.at(-1).key, 'ArrowRight');
  assert.equal(keySpec('a').code, 'KeyA');
  assert.throws(() => keySpec('not-a-key'));
});
test('double click has two balanced press/release pairs', async () => {
  const events = [],
    page = { call: async (m, p) => events.push(p) };
  await interact(page, { action: 'click', x: 10, y: 20, clickCount: 2 });
  assert.deepEqual(
    events.filter((e) => e.type === 'mousePressed').map((e) => e.clickCount),
    [1, 2],
  );
  assert.equal(events.filter((e) => e.type === 'mouseReleased').length, 2);
});
test('wait times out with a structured result and rejects malformed conditions', async () => {
  const page = { evaluate: async () => false };
  assert.equal(
    (
      await interact(page, {
        action: 'wait',
        condition: 'ready',
        timeoutMs: 10,
      })
    ).code,
    'WAIT_TIMEOUT',
  );
  await assert.rejects(
    interact(page, { action: 'wait', condition: 'text' }),
    /text is required/,
  );
});
