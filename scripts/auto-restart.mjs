import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { endpoint } from '../src/cdp.js';
import {
  RESTART_FLAG,
  inspectProcess,
  waitForExit,
  requestQuit,
  launchDesktop,
  stateDirectory,
} from '../src/desktop.js';
const base = endpoint();
const directory = stateDirectory();
await mkdir(directory, { recursive: true });
const desktop = JSON.parse(process.argv[2]);
const inspect = () => inspectProcess(desktop.pid);
try {
  try {
    const r = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) process.exit(0);
  } catch {}
  const original = await inspect();
  if (!original || original.key !== desktop.key)
    throw new Error('DSH launch changed; restart skipped.');
  if (original.restarted)
    throw new Error(
      'Automatic restart already attempted for this launch, but debugging is unavailable. DSH has been left running. Quit and open DSH manually to try again.',
    );
  // Atomic per-process claim survives helper failure and plugin reloads. A new
  // manual launch has a different PID/start-time identity and can try immediately.
  const claims = join(directory, 'launch-attempts');
  await mkdir(claims, { recursive: true });
  try {
    await writeFile(
      join(claims, original.key),
      JSON.stringify({ pid: original.pid, key: original.key }),
      {
        flag: 'wx',
      },
    );
  } catch (error) {
    if (error.code === 'EEXIST') process.exit(0);
    throw error;
  }
  if ((await inspect())?.key !== original.key)
    throw new Error(
      'DSH launch changed before restart; automatic restart skipped.',
    );
  await writeFile(
    join(directory, 'restart-pending.txt'),
    'Quit DSH normally to finish enabling browser control. It will reopen automatically. This request expires after five minutes.',
  );
  await requestQuit(desktop);
  await waitForExit(original);
  await launchDesktop(desktop, [
    RESTART_FLAG,
    `--remote-debugging-port=${new URL(base).port}`,
    '--remote-debugging-address=127.0.0.1',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(
      'DSH reopened but its debugging endpoint did not become available.',
    );
  await rm(join(directory, 'restart-error.txt'), { force: true });
  await writeFile(
    join(directory, 'restart-success.json'),
    JSON.stringify({ time: Date.now(), endpoint: base }),
  );
} catch (error) {
  await writeFile(join(directory, 'restart-error.txt'), String(error.message));
} finally {
  await rm(join(directory, 'restart-pending.txt'), { force: true });
}
