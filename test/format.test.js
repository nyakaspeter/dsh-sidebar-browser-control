import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatControl,
  formatFind,
  formatLogs,
  formatRead,
} from '../src/format.js';

test('controls render as one compact line each', () => {
  assert.equal(
    formatControl({ ref: 'r1.2', kind: 'link', label: 'new', href: '/newest' }),
    'r1.2 link "new" → /newest',
  );
  assert.equal(
    formatControl({
      ref: 'r1.3',
      kind: 'textbox',
      label: 'Email',
      inputType: 'email',
      value: 'a@b.c',
      disabled: true,
    }),
    'r1.3 textbox "Email" (email) ="a@b.c" [disabled]',
  );
  assert.equal(
    formatControl({
      ref: 'r1.4',
      kind: 'checkbox',
      label: 'Remember',
      checked: true,
    }),
    'r1.4 checkbox "Remember" [x]',
  );
  assert.equal(
    formatControl({ ref: 'r1.5', kind: 'select', options: ['A', '*B'] }),
    'r1.5 select {A|*B}',
  );
});
test('reads are plain text with a continuation offset', () => {
  const text = formatRead({
    title: 'Docs',
    url: 'https://x.test/docs',
    readyState: 'complete',
    scope: 'main',
    text: 'Hello world',
    elements: [{ ref: 'r2.1', kind: 'button', label: 'Go' }],
    totalElements: 60,
    next: '6000,40',
  });
  assert.equal(
    text,
    [
      '# Docs',
      'https://x.test/docs · text: main content only (mode "page" for all)',
      '',
      'Hello world',
      '',
      'Controls (1 of 60):',
      'r2.1 button "Go"',
      '',
      'More: offset "6000,40"',
    ].join('\n'),
  );
  assert.match(
    formatRead({
      title: '',
      url: 'u',
      readyState: 'loading',
      text: '',
      elements: [],
    }),
    /still loading[\s\S]*No visible controls\./,
  );
});
test('find and logs render compact lists', () => {
  assert.match(formatFind({ found: [] }, 'x'), /^No match for "x"/);
  assert.equal(
    formatFind(
      { found: [{ ref: 'r1.9', kind: 'text', label: 'Pricing' }] },
      'pric',
    ),
    'Found 1 for "pric":\nr1.9 text "Pricing"',
  );
  const logs = formatLogs({
    mode: 'problems',
    console: [{ level: 'error', text: 'boom (app.js:3)' }],
    requests: [
      {
        n: 4,
        method: 'GET',
        status: 500,
        type: 'xhr',
        ms: 12,
        size: 2048,
        url: 'https://x/api',
      },
      {
        n: 5,
        method: 'GET',
        error: 'net::ERR_FAILED',
        type: 'script',
        url: 'https://x/a.js',
      },
    ],
    note: 'New since the last logs call.',
  });
  assert.equal(
    logs,
    [
      'Console (errors and warnings):',
      '[error] boom (app.js:3)',
      '',
      'Failed requests:',
      '#4 GET 500 xhr 12ms 2.0kB https://x/api',
      '#5 GET ERR net::ERR_FAILED script https://x/a.js',
      '',
      'New since the last logs call.',
    ].join('\n'),
  );
  assert.equal(
    formatLogs({
      request: {
        n: 2,
        method: 'POST',
        status: 201,
        type: 'fetch',
        url: 'https://x/api',
        mime: 'application/json',
        postData: '{"a":1}',
      },
      body: '{"ok":true}',
    }),
    '#2 POST 201 fetch https://x/api\ncontent-type: application/json\nrequest body:\n{"a":1}\nresponse body:\n{"ok":true}',
  );
});
