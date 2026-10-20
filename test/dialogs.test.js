import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CDP } from '../src/cdp.js';

test('dialog events interrupt blocked commands and retain dialog state until closed', async () => {
  const socket = new EventEmitter();
  socket.send = () => {};
  socket.close = () => {};
  const c = new CDP(socket),
    pending = c.evaluate('confirm("Proceed?")');
  socket.emit(
    'message',
    JSON.stringify({
      method: 'Page.javascriptDialogOpening',
      params: { type: 'confirm', message: 'Proceed?' },
    }),
  );
  await assert.rejects(pending, (e) => e.dialog.type === 'confirm');
  assert.equal(c.pending.size, 0);
  assert.equal(c.dialog.message, 'Proceed?');
  socket.emit(
    'message',
    JSON.stringify({
      method: 'Page.javascriptDialogClosed',
      params: { result: false },
    }),
  );
  assert.equal(c.dialog, null);
  c.close();
});
