import test from 'node:test';
import assert from 'node:assert/strict';
import { interact, keySpec } from '../src/interactions.js';
test('keyboard input releases keys even when cancelled', async () => {
  const abort = new AbortController(),
    events = [];
  const page = {
    call: async (method, params) => {
      events.push({ method, ...params });
      if (params.type === 'keyDown') {
        abort.abort(new Error('cancelled'));
        throw abort.signal.reason;
      }
    },
  };
  await assert.rejects(
    interact(page, { action: 'press', key: 'ArrowRight' }, abort.signal),
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
test('wait times out with a structured result', async () => {
  const page = { dom: async () => false };
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
});
test('punctuation, function keys and Shift produce the typed text', async () => {
  const press = async (key, modifiers) => {
    const events = [];
    await interact(
      { call: async (m, p) => events.push(p) },
      { action: 'press', key, modifiers: modifiers && [modifiers] },
    );
    return events.find((e) => e.type === 'keyDown');
  };
  assert.equal((await press('1', 'Shift')).text, '!');
  assert.equal((await press('a', 'Shift')).text, 'A');
  const bang = await press('!');
  assert.deepEqual([bang.text, bang.code, bang.modifiers], ['!', 'Digit1', 8]);
  const slash = await press('/');
  assert.deepEqual([slash.text, slash.code], ['/', 'Slash']);
  const f5 = await press('F5');
  assert.deepEqual(
    [f5.text, f5.code, f5.windowsVirtualKeyCode],
    [undefined, 'F5', 116],
  );
  assert.equal((await press('a', 'Control')).text, undefined);
  assert.equal((await press('Enter', 'Shift')).text, '\r');
});
