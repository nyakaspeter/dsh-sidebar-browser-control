import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotGuard } from '../src/screenshot.js';
import { apply } from '../src/index.js';

test('hidden capture returns guidance, suppresses retries, allows explicit retry', async () => {
  const guard = new ScreenshotGuard();
  let calls = 0;
  const capture = async () => {
    calls++;
    return { data: 'png' };
  };
  const hidden = await guard.capture('a', {
    visible: async () => false,
    capture,
  });
  assert.equal(hidden.code, 'SCREENSHOT_UNAVAILABLE');
  assert.equal(hidden.retryable, false);
  assert.match(hidden.message, /Do not retry/);
  assert.equal(calls, 0);
  assert.deepEqual(
    await guard.capture('a', { visible: async () => true, capture }),
    hidden,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await guard.capture('a', {
      visible: async () => true,
      capture,
      retry: true,
    }),
    { data: 'png' },
  );
  assert.equal(calls, 1);
});
test('stalled capture is bounded, other tabs remain usable, cancellation propagates', async () => {
  const guard = new ScreenshotGuard(20);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await guard.capture('a', {
      visible: async () => true,
      capture: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    });
    assert.equal(result.code, 'SCREENSHOT_UNAVAILABLE');
    assert.deepEqual(
      await guard.capture('b', {
        visible: async () => true,
        capture: async () => ({ data: 'ok' }),
      }),
      { data: 'ok' },
    );
    const abort = new AbortController();
    abort.abort(new Error('cancelled'));
    await assert.rejects(
      guard.capture('c', { signal: abort.signal }),
      /cancelled/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
});
test('screenshot failures render as text and successes as images', () => {
  let tool;
  const cleanup = [];
  apply({
    effect: (fn) => cleanup.push(fn()),
    tools: { register: (t) => (tool = t) },
  });
  try {
    assert.equal(
      tool.output.render(
        { action: 'screenshot' },
        JSON.stringify({ ok: false, code: 'SCREENSHOT_UNAVAILABLE' }),
      )[0].type,
      'text',
    );
    assert.equal(
      tool.output.render(
        { action: 'screenshot' },
        JSON.stringify({
          attachment: {
            attachmentId: 'sha256:test',
            mediaType: 'image/png',
            bytes: 3,
            width: 1,
            height: 1,
          },
        }),
      )[0].type,
      'image',
    );
  } finally {
    cleanup.forEach((f) => f());
  }
});
