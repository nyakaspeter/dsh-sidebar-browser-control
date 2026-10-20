import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EndpointCache,
  discoverEndpoint,
  parseActivePort,
} from '../src/endpoint.js';
import { userDataDirectory } from '../src/desktop.js';

const file = '41234\n/devtools/browser/0b5c6e3e-1111-4222-8333-944455556666\n';
const version = (path) => async (url) => {
  assert.equal(url, 'http://127.0.0.1:41234/json/version');
  return {
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:41234${path}` }),
  };
};

test('DevToolsActivePort parsing rejects malformed content', () => {
  assert.deepEqual(parseActivePort(file), {
    port: 41234,
    browserPath: '/devtools/browser/0b5c6e3e-1111-4222-8333-944455556666',
  });
  for (const bad of ['', '0\n/devtools/browser/x', 'abc\n/x', '9222\n/other/x'])
    assert.equal(parseActivePort(bad), null);
});
test('discovery verifies the browser socket path so stale files and squatters fail', async () => {
  const read = async () => file;
  assert.equal(
    await discoverEndpoint({
      directory: '/dsh',
      read,
      request: version(
        '/devtools/browser/0b5c6e3e-1111-4222-8333-944455556666',
      ),
    }),
    'http://127.0.0.1:41234',
  );
  assert.equal(
    await discoverEndpoint({
      directory: '/dsh',
      read,
      request: version('/devtools/browser/someone-else'),
    }),
    null,
  );
  assert.equal(
    await discoverEndpoint({
      directory: '/dsh',
      read,
      request: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
    null,
  );
  assert.equal(
    await discoverEndpoint({
      directory: '/dsh',
      read: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    }),
    null,
  );
});
test('endpoint cache reuses a found endpoint and rediscovers after invalidation', async () => {
  let calls = 0;
  const cache = new EndpointCache(async () => (++calls, 'http://127.0.0.1:1'));
  await cache.get();
  await cache.get();
  assert.equal(calls, 1);
  cache.invalidate();
  await cache.get();
  assert.equal(calls, 2);
  let missing = 0;
  const empty = new EndpointCache(async () => (++missing, null));
  await empty.get();
  await empty.get();
  assert.equal(missing, 2, 'a missing endpoint is never cached');
});
test('Electron user data directory follows each platform convention', () => {
  assert.equal(
    userDataDirectory('darwin', {}, '/Users/u'),
    '/Users/u/Library/Application Support/@deepseek-ai/dsh-desktop',
  );
  assert.equal(
    userDataDirectory('linux', {}, '/home/u'),
    '/home/u/.config/@deepseek-ai/dsh-desktop',
  );
  assert.equal(
    userDataDirectory('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/u'),
    '/cfg/@deepseek-ai/dsh-desktop',
  );
  assert.equal(
    userDataDirectory('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }),
    'C:\\Users\\u\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop',
  );
});
