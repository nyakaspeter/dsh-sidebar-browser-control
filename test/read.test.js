import test from 'node:test';
import assert from 'node:assert/strict';
import { combineRead, prefixRefs, readLimits } from '../src/read.js';

const part = (text, count, url = 'https://a.example/', prefix = 'e') => ({
  url,
  title: 'T',
  readyState: 'complete',
  text,
  textLength: text.length,
  elements: Array.from({ length: count }, (_, i) => ({ ref: `${prefix}${i}` })),
  total: count,
});

test('compact reads paginate text and elements with next offsets', () => {
  const result = combineRead([part('x'.repeat(7000), 50)], {});
  assert.equal(result.text.length, 6000);
  assert.equal(result.elements.length, 40);
  assert.equal(result.next, '6000,40');
  const rest = combineRead([part('x'.repeat(7000), 50)], {
    textOffset: 6000,
    elementOffset: 40,
  });
  assert.equal(rest.text.length, 1000);
  assert.equal(rest.elements.length, 10);
  assert.equal(rest.next, undefined);
  assert.equal(
    combineRead([part('x'.repeat(7000), 50)], { detail: 'full' }).next,
    undefined,
  );
});
test('cross-origin frames append labelled text and prefixed refs', () => {
  const frame = prefixRefs(part('inside', 2, 'https://b.example/f'), 'f1');
  const result = combineRead([part('outer', 1), frame], {}, [
    { src: 'https://c.example/' },
  ]);
  assert.equal(result.text, 'outer\n\n[Frame https://b.example/f]\ninside');
  assert.deepEqual(
    result.elements.map((e) => e.ref),
    ['e0', 'f1:e0', 'f1:e1'],
  );
  assert.deepEqual(result.frames, [
    { url: 'https://b.example/f', elements: 2 },
  ]);
  assert.deepEqual(result.inaccessibleFrames, [{ src: 'https://c.example/' }]);
});
test('text truncated by the in-page cap still reports more text', () => {
  const capped = { ...part('x'.repeat(100), 0), textLength: 500000 };
  const result = combineRead([capped], { textOffset: 0 });
  assert.equal(result.next, '6000,0');
});
test('read offsets are validated', () => {
  assert.throws(() => readLimits({ textOffset: -1 }), /nonnegative/);
  assert.throws(() => readLimits({ elementOffset: 1.5 }), /nonnegative/);
});
