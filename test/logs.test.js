import test from 'node:test';
import assert from 'node:assert/strict';
import { PageLogs } from '../src/logs.js';

function fakeCdp(bodies = {}) {
  const listeners = new Map(),
    calls = [];
  return {
    calls,
    on(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
      return () => {};
    },
    emit(method, params, sessionId) {
      for (const fn of listeners.get(method) ?? []) fn(params, sessionId);
    },
    async call(method, params, _signal, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === 'Network.getResponseBody') {
        if (!(params.requestId in bodies)) throw new Error('No resource');
        return bodies[params.requestId];
      }
      return {};
    },
  };
}
const request = (cdp, id, url, extra = {}, sid) =>
  cdp.emit(
    'Network.requestWillBeSent',
    {
      requestId: id,
      type: 'XHR',
      timestamp: 1,
      request: { url, method: 'GET', headers: { Cookie: 'secret' } },
      ...extra,
    },
    sid,
  );

test('requests and console are recorded and shown incrementally', async () => {
  const cdp = fakeCdp();
  const logs = new PageLogs(cdp);
  logs.listen();
  request(cdp, 'a', 'https://x/ok');
  cdp.emit('Network.responseReceived', {
    requestId: 'a',
    response: { status: 200, mimeType: 'application/json' },
  });
  cdp.emit('Network.loadingFinished', {
    requestId: 'a',
    timestamp: 1.25,
    encodedDataLength: 10,
  });
  request(cdp, 'b', 'https://x/missing');
  cdp.emit('Network.responseReceived', {
    requestId: 'b',
    response: { status: 404 },
  });
  request(cdp, 'c', 'https://x/aborted');
  cdp.emit('Network.loadingFailed', {
    requestId: 'c',
    errorText: 'net::ERR_ABORTED',
    canceled: true,
  });
  cdp.emit('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'string', value: 'boom' }],
  });
  cdp.emit('Runtime.consoleAPICalled', {
    type: 'log',
    args: [{ type: 'number', value: 1 }],
  });
  const first = await logs.query({});
  assert.deepEqual(
    first.requests.map((r) => r.url),
    ['https://x/missing'],
    'canceled requests are not problems',
  );
  assert.deepEqual(
    first.console.map((c) => c.text),
    ['boom'],
  );
  assert.deepEqual((await logs.query({})).requests, [], 'nothing new');
  cdp.emit('Runtime.exceptionThrown', {
    exceptionDetails: {
      exception: { description: 'TypeError: x' },
      url: 'https://x/app.js',
      lineNumber: 4,
    },
  });
  assert.deepEqual(
    (await logs.query({})).console.map((c) => c.text),
    ['TypeError: x (app.js:5)'],
  );
  assert.equal((await logs.query({ all: true })).requests.length, 1);
  const all = await logs.query({ mode: 'requests', all: true });
  assert.equal(all.requests.length, 3);
  assert.equal(all.requests[0].ms, 250);
  assert.ok(!JSON.stringify(all).includes('secret'), 'headers are never kept');
  assert.deepEqual(
    (
      await logs.query({ mode: 'requests', all: true, filter: 'missing' })
    ).requests.map((r) => r.n),
    [2],
  );
  assert.deepEqual(
    (await logs.query({ mode: 'console' })).console.map((c) => c.level),
    ['error', 'log', 'error'],
  );
});
test('buffers stay bounded', async () => {
  const cdp = fakeCdp();
  const logs = new PageLogs(cdp);
  logs.listen();
  for (let i = 0; i < 150; i++) request(cdp, `r${i}`, `https://x/${i}`);
  for (let i = 0; i < 80; i++)
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'x'.repeat(900) }],
    });
  assert.equal(logs.requests.length, 100);
  assert.equal(logs.console.length, 50);
  assert.ok(logs.console[0].text.length <= 500);
  assert.equal((await logs.query({ mode: 'requests' })).requests.length, 50);
});
test('request details fetch bodies from the right session', async () => {
  const cdp = fakeCdp({
    json: { body: '{"ok":true}', base64Encoded: false },
    img: { body: Buffer.from('PNG').toString('base64'), base64Encoded: true },
  });
  const logs = new PageLogs(cdp);
  logs.listen();
  request(
    cdp,
    'json',
    'https://x/api',
    { request: { url: 'https://x/api', method: 'POST', postData: '{"q":1}' } },
    'frame',
  );
  cdp.emit(
    'Network.responseReceived',
    {
      requestId: 'json',
      response: { status: 200, mimeType: 'application/json' },
    },
    'frame',
  );
  cdp.emit(
    'Network.loadingFinished',
    { requestId: 'json', timestamp: 2 },
    'frame',
  );
  request(cdp, 'img', 'https://x/a.png');
  cdp.emit('Network.responseReceived', {
    requestId: 'img',
    response: { status: 200, mimeType: 'image/png' },
  });
  cdp.emit('Network.loadingFinished', { requestId: 'img', timestamp: 2 });
  request(cdp, 'gone', 'https://x/gone');
  cdp.emit('Network.loadingFinished', { requestId: 'gone', timestamp: 2 });
  const json = await logs.detail(1);
  assert.equal(json.body, '{"ok":true}');
  assert.equal(json.request.postData, '{"q":1}');
  assert.deepEqual(cdp.calls.at(-1).slice(2), ['frame']);
  assert.equal((await logs.detail(2)).body, '(binary, 3 bytes)');
  assert.match((await logs.detail(3)).body, /unavailable/);
  await assert.rejects(logs.detail(99), /no longer recorded/);
});
