import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILD, PROTOCOL, compatibility } from '../src/compatibility.js';
test('compatible client succeeds and unsupported hosts return actionable non-retryable failures', () => {
  assert.equal(compatibility({ version: PROTOCOL, build: BUILD }), null);
  for (const [value, code] of [
    [null, 'BROWSER_UNAVAILABLE'],
    [{ compatibilityError: 'browser.acquire' }, 'DSH_INCOMPATIBLE'],
    [{ version: 99, build: BUILD }, 'PLUGIN_VERSION_MISMATCH'],
    [{ version: PROTOCOL, build: 'old' }, 'PLUGIN_VERSION_MISMATCH'],
  ]) {
    const result = compatibility(value);
    assert.equal(result.code, code);
    assert.equal(result.retryable, false);
  }
});
test('manifest declares an open DSH range instead of exact runtime pins', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  // DSH evaluates engines.dsh alone when present; exact @deepseek-ai/dsh-* peer
  // pins otherwise block the plugin on every DSH update.
  assert.match(manifest.engines?.dsh ?? '', /^>=\s*\d/);
  assert.doesNotMatch(manifest.engines.dsh, /</);
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {}))
    assert.doesNotMatch(range, /^\d/, `${name} must not pin an exact version`);
});
test('packaged browser client agrees with the package version', () => {
  const source = readFileSync(
    new URL('../src/client.js', import.meta.url),
    'utf8',
  );
  const builds = [...source.matchAll(/build:\s*["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  assert.ok(builds.length);
  assert.ok(builds.every((b) => b === BUILD));
});
