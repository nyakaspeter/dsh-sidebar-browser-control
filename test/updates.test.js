import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPOSITORY, UpdateChecker, compareVersions } from '../src/updates.js';

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('0.6.0', '0.6.1') < 0);
  assert.equal(REPOSITORY, 'nyakaspeter/dsh-sidebar-browser-control');
});
test('update checks hit GitHub at most daily and report reinstall steps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-upd-'));
  let now = 1_000_000,
    calls = 0;
  const request = async (url) => {
    calls++;
    assert.match(url, /repos\/owner\/repo\/releases\/latest$/);
    return new Response(
      JSON.stringify({ tag_name: 'v0.7.0', html_url: 'https://x/r' }),
    );
  };
  const make = () =>
    new UpdateChecker({
      current: '0.6.0',
      repository: 'owner/repo',
      directory,
      request,
      now: () => now,
    });
  const checker = make();
  const result = await checker.check();
  assert.equal(result.available, true);
  assert.equal(result.latest, '0.7.0');
  assert.match(result.message, /Add plugin/);
  await checker.check();
  assert.equal(calls, 1);
  assert.equal((await make().check()).available, true);
  assert.equal(calls, 1, 'a fresh process reuses the on-disk result');
  now += 25 * 60 * 60 * 1000;
  await make().check();
  assert.equal(calls, 2);
});
test('failed or older release lookups report no update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-upd-'));
  const failing = new UpdateChecker({
    current: '0.6.0',
    repository: 'owner/repo',
    directory,
    request: async () => {
      throw new Error('offline');
    },
  });
  assert.equal((await failing.check()).available, false);
  const older = new UpdateChecker({
    current: '0.6.0',
    repository: 'owner/repo',
    directory: await mkdtemp(join(tmpdir(), 'dsh-upd-')),
    request: async () => new Response(JSON.stringify({ tag_name: 'v0.5.0' })),
  });
  assert.equal((await older.check()).available, false);
});
