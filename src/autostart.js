import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverEndpoint } from './endpoint.js';
import { discoverDesktop, stateDirectory } from './desktop.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The helper survives the host's normal quit and launches the same app with CDP.
export async function ensureDesktopDebugging() {
  if (
    process.env.NODE_TEST_CONTEXT ||
    !['darwin', 'win32', 'linux'].includes(process.platform)
  )
    return;
  if (await discoverEndpoint()) return;
  try {
    const desktop = await discoverDesktop();
    const child = spawn(
      desktop.node,
      [
        fileURLToPath(new URL('../scripts/auto-restart.mjs', import.meta.url)),
        JSON.stringify(desktop),
      ],
      { detached: true, stdio: 'ignore', windowsHide: true, env: process.env },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    const directory = stateDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'restart-error.txt'), error.message);
  }
}
