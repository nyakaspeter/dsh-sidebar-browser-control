import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { endpoint } from './cdp.js';
import { userDataDirectory } from './desktop.js';

export const DEVTOOLS_FILE = 'DevToolsActivePort';

// DSH is launched with --remote-debugging-port=0, so the port is random and
// recorded with the browser socket path. A stale file (crash, old launch) or a
// different process on that port fails the browser-path check.
export function parseActivePort(text) {
  const [portLine, browserPath] = String(text).trim().split(/\r?\n/);
  const port = Number(portLine);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser\/[\w-]+$/.test(browserPath ?? '')
  )
    return null;
  return { port, browserPath };
}

export async function discoverEndpoint({
  directory = userDataDirectory(),
  read = readFile,
  request = fetch,
} = {}) {
  let active;
  try {
    active = parseActivePort(
      await read(join(directory, DEVTOOLS_FILE), 'utf8'),
    );
  } catch {
    return null;
  }
  if (!active) return null;
  const base = endpoint(`http://127.0.0.1:${active.port}`);
  try {
    const response = await request(`${base}/json/version`, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const version = await response.json();
    if (new URL(version.webSocketDebuggerUrl).pathname !== active.browserPath)
      return null;
  } catch {
    return null;
  }
  return base;
}

// Avoid rereading the file on every tool call while still noticing restarts.
export class EndpointCache {
  constructor(discover = discoverEndpoint, ttlMs = 5000) {
    this.discover = discover;
    this.ttlMs = ttlMs;
    this.value = null;
    this.expires = 0;
  }
  async get() {
    if (this.value && Date.now() < this.expires) return this.value;
    this.value = await this.discover();
    this.expires = Date.now() + this.ttlMs;
    return this.value;
  }
  invalidate() {
    this.value = null;
    this.expires = 0;
  }
}
