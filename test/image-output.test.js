import test from 'node:test';
import assert from 'node:assert/strict';
import { admitScreenshot, renderBrowserOutput } from '../src/image-output.js';
const ref = {
  attachmentId: 'sha256:test',
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
};
const exec = {
  agent: { options: { provider: 'test', model: 'vision' } },
  signal: new AbortController().signal,
};
test('screenshots use durable native attachment references, never raw MCP image blocks', async () => {
  let saved;
  const ctx = {
    get: (name) =>
      ({
        llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
        attachments: {
          saveImages: async (images) => {
            saved = images;
            return [ref];
          },
        },
      })[name],
  };
  const value = await admitScreenshot(ctx, exec, { data: 'YWJj' });
  assert.deepEqual(saved, [
    { data: Buffer.from('abc'), mediaType: 'image/png' },
  ]);
  const blocks = renderBrowserOutput(
    { action: 'screenshot' },
    JSON.stringify(value),
  );
  assert.deepEqual(blocks, [{ type: 'image', attachment: ref }]);
  assert.equal(blocks[0].data, undefined);
});
test('unsupported model and storage failures produce text instead of invalid images', async () => {
  for (const vision of [false, true]) {
    const ctx = {
      get: (name) =>
        ({
          llm: {
            resolveModelInfo: async () => ({
              inputModalities: vision ? ['image'] : ['text'],
            }),
          },
          attachments: {
            saveImages: async () => {
              throw new Error('storage unavailable');
            },
          },
        })[name],
    };
    const result = await admitScreenshot(ctx, exec, { data: 'YWJj' });
    assert.equal(result.code, 'SCREENSHOT_UNAVAILABLE');
    assert.equal(
      renderBrowserOutput({ action: 'screenshot' }, JSON.stringify(result))[0]
        .type,
      'text',
    );
  }
  assert.equal(
    renderBrowserOutput(
      { action: 'screenshot' },
      JSON.stringify({ data: 'YWJj' }),
    )[0].type,
    'text',
  );
});
test('screenshots include the stored host image Markdown for inline delivery', async () => {
  const ctx = {
    get: (name) =>
      ({
        llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
        attachments: {
          saveImages: async () => [ref],
          imageHostPath: () => '/test images/capture.png',
        },
      })[name],
  };
  const value = await admitScreenshot(ctx, exec, { data: 'YWJj' });
  assert.equal(
    value.displayMarkdown,
    '![Browser screenshot](</test images/capture.png>)',
  );
  const blocks = renderBrowserOutput(
    { action: 'screenshot' },
    JSON.stringify(value),
  );
  assert.equal(blocks[0].type, 'image');
  assert.match(blocks[1].text, /include this exact Markdown/);
});
