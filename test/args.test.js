import test from 'node:test';
import assert from 'node:assert/strict';
import { PARAMETERS, normalize, parseTarget } from '../src/args.js';

const n = (args) => normalize({ tabId: 't', ...args });

test('the public schema stays small', () => {
  assert.equal(Object.keys(PARAMETERS).length, 12);
});
test('targets are refs, coordinates or selectors', () => {
  assert.deepEqual(parseTarget('r3.12'), { ref: 'r3.12' });
  assert.deepEqual(parseTarget('f1:r2.4'), { ref: 'f1:r2.4' });
  assert.deepEqual(parseTarget('120, 40.5'), { x: 120, y: 40.5 });
  assert.deepEqual(parseTarget('#login button'), { selector: '#login button' });
  assert.deepEqual(parseTarget(undefined), {});
});
test('modes map onto internal arguments', () => {
  assert.equal(
    n({ action: 'click', target: 'r1.1', mode: 'right' }).button,
    'right',
  );
  assert.equal(
    n({ action: 'click', target: 'r1.1', mode: 'double' }).clickCount,
    2,
  );
  assert.deepEqual(
    [n({ action: 'type', target: 'r1.1', mode: 'uncheck' })].map((a) => [
      a.mode,
      a.checked,
    ]),
    [['check', false]],
  );
  assert.equal(n({ action: 'type', target: 'r1.1', text: 'hi' }).mode, 'fill');
  assert.deepEqual(
    (({ key, modifiers }) => ({ key, modifiers }))(
      n({ action: 'press', text: 'Control+Shift+k' }),
    ),
    { key: 'k', modifiers: ['Control', 'Shift'] },
  );
  assert.equal(n({ action: 'press', text: 'Control++' }).key, '+');
  assert.throws(
    () => n({ action: 'press', text: 'Ctrl+a' }),
    /Alt, Control, Meta or Shift/,
  );
  assert.throws(
    () => n({ action: 'wait', tabId: 't', mode: 'text' }),
    /wait text requires text/,
  );
  assert.equal(n({ action: 'scroll', mode: 'up' }).deltaY, -600);
  assert.equal(
    n({ action: 'scroll', target: 'r1.1', mode: 'into' }).intoView,
    true,
  );
  assert.equal(n({ action: 'wait' }).condition, 'ready');
  assert.equal(n({ action: 'wait', target: 'r1.1' }).condition, 'visible');
  const read = n({
    action: 'read',
    mode: 'page',
    full: true,
    offset: '6000,40',
  });
  assert.deepEqual(
    [read.scope, read.detail, read.textOffset, read.elementOffset],
    ['page', 'full', 6000, 40],
  );
  assert.equal(n({ action: 'evaluate', text: '1+1' }).expression, '1+1');
  assert.equal(
    n({ action: 'screenshot', full: true, retry: true }).fullPage,
    true,
  );
  const drag = n({ action: 'drag', target: 'r1.1', text: '300,200' });
  assert.deepEqual([drag.ref, drag.toX, drag.toY], ['r1.1', 300, 200]);
  assert.equal(n({ action: 'logs', text: '#12' }).request, 12);
  assert.equal(
    n({ action: 'logs', mode: 'requests', text: '/api' }).filter,
    '/api',
  );
  assert.equal(n({ action: 'logs', full: true }).all, true);
  assert.equal(n({ action: 'find', text: 'Sign in' }).query, 'Sign in');
});
test('invalid input fails early with guidance', () => {
  for (const [args, message] of [
    [
      { action: 'click', mode: 'triple', target: 'r1.1' },
      /left\/right\/middle\/double/,
    ],
    [{ action: 'hover', mode: 'x', target: 'r1.1' }, /does not take a mode/],
    [{ action: 'click' }, /requires target/],
    [{ action: 'type', target: 'r1.1' }, /requires text/],
    [{ action: 'read', offset: 'later' }, /offset/],
    [{ action: 'drag', target: 'r1.1' }, /drop target/],
    [{ action: 'find' }, /requires text/],
    [{ action: 'download' }, /url or target/],
    [{ action: 'upload', target: 'r1.1' }, /files/],
  ])
    assert.throws(() => n(args), message);
  assert.throws(() => normalize({ action: 'read' }), /tabId/);
  assert.equal(normalize({ action: 'list' }).action, 'list');
  assert.throws(() => normalize({ action: 'open' }), /url/);
});
