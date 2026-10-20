import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { stateDirectory } from './desktop.js';

const DAY = 24 * 60 * 60 * 1000;
export const REPOSITORY = /github\.com[/:]([^/]+\/[^/.]+)/.exec(
  metadata.repository?.url ?? '',
)?.[1];

export function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return x[i] - y[i];
  return 0;
}

// DSH has no plugin update mechanism; the plugin checks GitHub releases at most
// daily and reports how to reinstall. Disabled by the checkForUpdates setting.
export class UpdateChecker {
  constructor({
    current = metadata.version,
    repository = REPOSITORY,
    directory = stateDirectory(),
    request = fetch,
    now = Date.now,
  } = {}) {
    Object.assign(this, { current, repository, directory, request, now });
    this.pending = null;
    this.result = null;
  }
  get file() {
    return join(this.directory, 'update-check.json');
  }
  async check() {
    if (!this.repository) return null;
    if (this.result && this.now() - this.result.checkedAt < DAY)
      return this.summary();
    this.pending ??= this.refresh().finally(() => (this.pending = null));
    await this.pending;
    return this.summary();
  }
  async refresh() {
    try {
      const cached = JSON.parse(await readFile(this.file, 'utf8'));
      if (this.now() - cached.checkedAt < DAY) return (this.result = cached);
    } catch {}
    try {
      const response = await this.request(
        `https://api.github.com/repos/${this.repository}/releases/latest`,
        {
          signal: AbortSignal.timeout(5000),
          headers: { accept: 'application/vnd.github+json' },
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();
      this.result = {
        checkedAt: this.now(),
        latest: String(release.tag_name ?? '').replace(/^v/, ''),
        url: release.html_url,
      };
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.file, JSON.stringify(this.result));
    } catch {
      this.result = { checkedAt: this.now(), latest: null };
    }
    return this.result;
  }
  summary() {
    const latest = this.result?.latest;
    if (!latest || compareVersions(latest, this.current) <= 0)
      return { available: false, current: this.current };
    return {
      available: true,
      current: this.current,
      latest,
      url: this.result.url,
      message: `dsh-sidebar-browser-control ${latest} is available (installed ${this.current}). Reinstall it from https://github.com/${this.repository} in Plugins → Add plugin, then fully quit and reopen DSH.`,
    };
  }
}
