import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SidebarController } from '../src/controller.js';
import { CDP } from '../src/cdp.js';
test('a blocked chat does not delay another chat; same-chat operations remain ordered', async () => {
  const c = new SidebarController();
  let release;
  const gate = new Promise((r) => (release = r)),
    events = [];
  c.execute = async (args, s) => {
    events.push(args.action);
    if (args.action === 'slow') await gate;
    return s;
  };
  try {
    const slow = c.run({ action: 'slow' }, 'A');
    const queued = c.run({ action: 'queued' }, 'A');
    assert.equal(await c.run({ action: 'fast' }, 'B'), 'B');
    assert.deepEqual(events, ['slow', 'fast']);
    release();
    await Promise.all([slow, queued]);
    assert.deepEqual(events, ['slow', 'fast', 'queued']);
    await Promise.resolve();
    assert.equal(c.queues.size, 0);
  } finally {
    release();
    c.dispose();
  }
});
test('cancelled queued work never executes and failed operations do not poison the queue', async () => {
  const c = new SidebarController(),
    abort = new AbortController();
  let calls = 0;
  c.execute = async () => ++calls;
  abort.abort();
  try {
    await assert.rejects(c.run({}, 'A', abort.signal));
    assert.equal(await c.run({}, 'A'), 1);
  } finally {
    c.dispose();
  }
});
test('closing a connection clears owned page bookkeeping and screenshot failure state', () => {
  const c = new SidebarController();
  let closed = false;
  const page = {
    close() {
      closed = true;
    },
  };
  c.connections.set('target', page);
  c.pages.set('tab', page);
  c.screenshots.blocked.set('tab', {});
  c.release(page);
  assert.equal(closed, true);
  assert.equal(c.connections.size, 0);
  assert.equal(c.pages.size, 0);
  assert.equal(c.screenshots.blocked.size, 0);
  c.dispose();
});
