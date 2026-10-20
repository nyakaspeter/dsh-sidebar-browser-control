import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEBUG_FLAGS,
  performRestart,
  waitForStableEndpoint,
} from '../src/restart.js';
import { isDesktopCommand } from '../src/desktop.js';

const desktop = {
  pid: 10,
  key: 'k10',
  binary: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
};
const original = { pid: 10, key: 'k10', restarted: false };
const flagged = { pid: 11, key: 'k11', restarted: true };
const base = 'http://127.0.0.1:5000';

async function scenario(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
  const events = [];
  const result = await performRestart(desktop, {
    directory,
    discover: async () => null,
    inspect: async () => original,
    list: async () => [],
    quit: async () => events.push('quit'),
    waitExit: async () => events.push('exited'),
    launch: async (_d, flags) => events.push(['launch', flags]),
    stable: async () => base,
    ...overrides,
  });
  const files = await readdir(directory);
  const read = (name) => readFile(join(directory, name), 'utf8');
  return { result, events, files, read };
}

test('a normal launch is quit once and relaunched with debugging flags', async () => {
  const { result, events, files, read } = await scenario();
  assert.equal(result.status, 'restarted');
  assert.deepEqual(events, ['quit', 'exited', ['launch', DEBUG_FLAGS]]);
  assert.ok(DEBUG_FLAGS.includes('--remote-debugging-port=0'));
  assert.equal(JSON.parse(await read('restart-success.json')).endpoint, base);
  assert.ok(!files.includes('restart-pending.txt'));
});
test('a DSH reopened by the user while waiting is left to its own plugin', async () => {
  let afterExit = false;
  const { result, events, files } = await scenario({
    waitExit: async () => (afterExit = true),
    list: async () => (afterExit ? [{ pid: 12, restarted: false }] : []),
  });
  assert.equal(result.status, 'reopened-by-user');
  assert.ok(!events.some((e) => e[0] === 'launch'), 'no second launch');
  assert.ok(!files.includes('restart-success.json'));
  assert.ok(!files.includes('restart-error.txt'));
});
test('an endpoint that does not stay available is reported as a failure', async () => {
  const { result, files, read } = await scenario({ stable: async () => null });
  assert.equal(result.status, 'failed');
  assert.ok(!files.includes('restart-success.json'));
  assert.match(await read('restart-error.txt'), /did not stay available/);
});
test('each launch is claimed once and an already restarted launch is not retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
  const deps = {
    directory,
    discover: async () => null,
    inspect: async () => original,
    list: async () => [],
    quit: async () => {},
    waitExit: async () => {},
    launch: async () => {},
    stable: async () => base,
  };
  assert.equal((await performRestart(desktop, deps)).status, 'restarted');
  assert.equal(
    (await performRestart(desktop, deps)).status,
    'claimed-elsewhere',
  );
  const again = await performRestart(desktop, {
    ...deps,
    inspect: async () => ({ ...original, restarted: true }),
  });
  assert.equal(again.status, 'failed');
  assert.match(again.error, /already attempted/);
  const enabled = await performRestart(desktop, {
    ...deps,
    discover: async () => base,
  });
  assert.equal(enabled.status, 'already-enabled');
});
test('stable endpoint needs a flagged process and the same port after settling', async () => {
  const sleep = async () => {};
  // A short-lived launch publishes a port, then exits before settling.
  let calls = 0;
  assert.equal(
    await waitForStableEndpoint(desktop, {
      sleep,
      attempts: 3,
      discover: async () => (++calls === 1 ? base : null),
      list: async () => [flagged],
    }),
    null,
  );
  // An endpoint served while only an unflagged DSH runs is not ours.
  assert.equal(
    await waitForStableEndpoint(desktop, {
      sleep,
      attempts: 3,
      discover: async () => base,
      list: async () => [{ ...original }],
    }),
    null,
  );
  assert.equal(
    await waitForStableEndpoint(desktop, {
      sleep,
      discover: async () => base,
      list: async () => [flagged],
    }),
    base,
  );
});
test('DSH main processes are recognized without helpers or the Node host', () => {
  const mac = desktop.binary;
  assert.equal(
    isDesktopCommand(`${mac} --dsh-sidebar-restarted`, mac, 'darwin'),
    true,
  );
  assert.equal(isDesktopCommand(mac, mac, 'darwin'), true);
  for (const command of [
    `${mac} --type=renderer`,
    `${mac} --expose-internals /x/index.js`,
    `/node /p/scripts/auto-restart.mjs {}`,
    `${mac}Helper`,
    '/Applications/Other.app/Contents/MacOS/Other',
  ])
    assert.equal(isDesktopCommand(command, mac, 'darwin'), false, command);
  assert.equal(
    isDesktopCommand(
      '"C:\\Program Files\\DSH\\DeepSeek Harness.exe" --dsh-sidebar-restarted',
      'C:\\Program Files\\DSH\\DeepSeek Harness.exe',
      'win32',
    ),
    true,
  );
  assert.equal(
    isDesktopCommand(
      '/tmp/.mount_new123/deepseek-harness --no-sandbox',
      '/tmp/.mount_old456/deepseek-harness',
      'linux',
    ),
    true,
    'AppImage mount paths change per launch',
  );
});
