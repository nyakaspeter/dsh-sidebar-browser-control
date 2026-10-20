import test from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForExit,
  installation,
  stateDirectory,
  processIdentity,
  discoverDesktop,
  inspectProcess,
  RESTART_FLAG,
} from '../src/desktop.js';

test('installation paths follow moved macOS, Windows, and Linux installs', () => {
  const mac = installation(
    '/Volumes/Apps/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    'darwin',
    {},
  );
  assert.equal(mac.app, '/Volumes/Apps/DeepSeek Harness.app');
  assert.equal(
    mac.nodes[0],
    '/Volumes/Apps/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node',
  );
  const windows = installation(
    'D:\\Portable Apps\\DeepSeek Harness.exe',
    'win32',
    {},
  );
  assert.equal(windows.resources, 'D:\\Portable Apps\\resources');
  assert.equal(
    windows.nodes[0],
    'D:\\Portable Apps\\resources\\runtime\\primary-runtime\\dependencies\\node\\node.exe',
  );
  const linux = installation('/opt/dsh/deepseek-harness', 'linux', {});
  assert.equal(linux.launcher, linux.binary);
  assert.equal(linux.resources, '/opt/dsh/resources');
  assert.equal(
    installation('/tmp/.mount_dsh/deepseek-harness', 'linux', {
      APPIMAGE: '/home/user/My DSH.AppImage',
    }).launcher,
    '/home/user/My DSH.AppImage',
  );
});

test('state directories use native platform conventions', () => {
  assert.equal(
    stateDirectory('darwin', {}, '/Users/test'),
    '/Users/test/Library/Application Support/dsh-sidebar-browser-control',
  );
  assert.equal(
    stateDirectory('win32', { LOCALAPPDATA: 'D:\\Local' }, 'C:\\Users\\test'),
    'D:\\Local\\dsh-sidebar-browser-control',
  );
  assert.equal(
    stateDirectory('linux', { XDG_STATE_HOME: '/state' }, '/home/test'),
    '/state/dsh-sidebar-browser-control',
  );
});

test('launch identity detects PID reuse and restart markers', () => {
  const record = { pid: 42, started: 'one', command: 'dsh' };
  assert.equal(processIdentity(record).key, processIdentity(record).key);
  assert.notEqual(
    processIdentity(record).key,
    processIdentity({ ...record, started: 'two' }).key,
  );
  assert.equal(processIdentity(record).restarted, false);
  for (const flag of [RESTART_FLAG, RESTART_FLAG + '=1'])
    assert.equal(
      processIdentity({ ...record, command: 'dsh ' + flag }).restarted,
      true,
    );
});

test('discovery follows only ancestors and skips host/renderer processes', async () => {
  const binary = '/opt/dsh/deepseek-harness';
  const records = new Map([
    [
      30,
      {
        pid: 30,
        parent: 20,
        binary,
        command: binary + ' --expose-internals host.js',
      },
    ],
    [20, { pid: 20, parent: 10, binary, command: binary + ' --type=renderer' }],
    [10, { pid: 10, parent: 1, binary, command: binary, key: 'launch' }],
  ]);
  const seen = [];
  const result = await discoverDesktop({
    pid: 30,
    platform: 'linux',
    env: {},
    inspect: async (pid) => records.get(pid),
    exists: async (p) => seen.push(p),
  });
  assert.equal(result.pid, 10);
  assert.equal(
    result.command,
    undefined,
    'do not pass command lines to detached helpers',
  );
  assert.ok(seen.includes('/opt/dsh/resources'));
  await assert.rejects(
    discoverDesktop({ pid: 30, platform: 'linux', inspect: async () => null }),
    /identify/,
  );
  await assert.rejects(
    discoverDesktop({
      pid: 30,
      platform: 'linux',
      env: {},
      inspect: async (pid) => records.get(pid),
      exists: async () => {
        throw new Error('missing');
      },
    }),
    /missing/,
  );
});

test('native process inspection identifies the current test process', async () => {
  const record = await inspectProcess(process.pid);
  assert.equal(record.pid, process.pid);
  assert.ok(record.binary);
  assert.ok(record.key);
  assert.ok(record.parent > 0);
});

test('restart waits for normal exit and stops on refusal or PID reuse', async () => {
  const original = { pid: 10, key: 'first' };
  let tick = 0;
  const clock = {
    now: () => tick,
    sleep: async (ms) => {
      tick += ms;
    },
    timeout: 1000,
  };
  await waitForExit(original, {
    ...clock,
    inspect: async () => (tick ? null : original),
  });
  assert.equal(tick, 500);
  tick = 0;
  await assert.rejects(
    waitForExit(original, { ...clock, inspect: async () => original }),
    /without forcing/,
  );
  tick = 0;
  await assert.rejects(
    waitForExit(original, {
      ...clock,
      inspect: async () => ({ key: 'reused' }),
    }),
    /identity changed/,
  );
});
