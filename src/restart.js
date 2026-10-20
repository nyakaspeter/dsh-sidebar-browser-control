import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverEndpoint } from './endpoint.js';
import {
  RESTART_FLAG,
  inspectProcess,
  launchDesktop,
  listDesktops,
  requestQuit,
  stateDirectory,
  waitForExit,
} from './desktop.js';

export const DEBUG_FLAGS = [
  RESTART_FLAG,
  // Port 0 picks a free random port, published in DevToolsActivePort.
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

// Success requires a running DSH started with the restart flag whose endpoint
// still verifies after a settle period: a second launch that hands off to an
// existing instance can publish a port briefly before exiting.
export async function waitForStableEndpoint(
  desktop,
  {
    discover = discoverEndpoint,
    list = listDesktops,
    sleep = (ms) => delay(ms),
    attempts = 60,
    interval = 250,
    settle = 1500,
  } = {},
) {
  const flagged = async () => (await list(desktop)).some((p) => p.restarted);
  for (let i = 0; i < attempts; i++) {
    const base = await discover();
    if (base && (await flagged())) {
      await sleep(settle);
      if ((await discover()) === base && (await flagged())) return base;
    }
    await sleep(interval);
  }
  return null;
}

// One automatic restart per manual launch: claim it, ask DSH to quit, wait for
// the exact process to exit, and relaunch with debugging unless the user has
// already reopened DSH (that launch's own plugin then handles its restart).
export async function performRestart(
  desktop,
  {
    directory = stateDirectory(),
    discover = discoverEndpoint,
    inspect = () => inspectProcess(desktop.pid),
    list = listDesktops,
    quit = requestQuit,
    waitExit = waitForExit,
    launch = launchDesktop,
    stable = (d) => waitForStableEndpoint(d, { discover, list }),
  } = {},
) {
  await mkdir(directory, { recursive: true });
  const file = (name) => join(directory, name);
  try {
    if (await discover()) return { status: 'already-enabled' };
    const original = await inspect();
    if (!original || original.key !== desktop.key)
      throw new Error('DSH launch changed; restart skipped.');
    if (original.restarted)
      throw new Error(
        'Automatic restart already attempted for this launch, but debugging is unavailable. DSH has been left running. Quit and open DSH manually to try again.',
      );
    // Atomic per-process claim survives helper failure and plugin reloads. A new
    // manual launch has a different PID/start-time identity and can try immediately.
    const claims = file('launch-attempts');
    await mkdir(claims, { recursive: true });
    try {
      await writeFile(
        join(claims, original.key),
        JSON.stringify({ pid: original.pid, key: original.key }),
        { flag: 'wx' },
      );
    } catch (error) {
      if (error.code === 'EEXIST') return { status: 'claimed-elsewhere' };
      throw error;
    }
    if ((await inspect())?.key !== original.key)
      throw new Error(
        'DSH launch changed before restart; automatic restart skipped.',
      );
    await writeFile(
      file('restart-pending.txt'),
      'Quit DSH normally to finish enabling browser control. It will reopen automatically. This request expires after five minutes.',
    );
    await quit(desktop);
    await waitExit(original);
    if ((await list(desktop)).length) return { status: 'reopened-by-user' };
    await launch(desktop, DEBUG_FLAGS);
    const base = await stable(desktop);
    if (!base)
      throw new Error(
        'DSH reopened but its debugging endpoint did not stay available.',
      );
    await rm(file('restart-error.txt'), { force: true });
    await writeFile(
      file('restart-success.json'),
      JSON.stringify({ time: Date.now(), endpoint: base }),
    );
    return { status: 'restarted', endpoint: base };
  } catch (error) {
    await writeFile(file('restart-error.txt'), String(error.message));
    return { status: 'failed', error: error.message };
  } finally {
    await rm(file('restart-pending.txt'), { force: true });
  }
}
