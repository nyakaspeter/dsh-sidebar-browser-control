import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, readlink } from 'node:fs/promises';
import { dirname, join, win32, posix } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
export const RESTART_FLAG = '--dsh-sidebar-restarted';

const exec = promisify(execFile);
const powershell = (script) =>
  exec(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 10000 },
  );

export function installation(
  binary,
  platform = process.platform,
  env = process.env,
) {
  const path = platform === 'win32' ? win32 : posix;
  const mac = platform === 'darwin';
  const resources = mac
    ? path.join(path.dirname(binary), '../Resources')
    : path.join(path.dirname(binary), 'resources');
  return {
    binary,
    app: mac ? path.resolve(binary, '../../..') : binary,
    launcher: platform === 'linux' && env.APPIMAGE ? env.APPIMAGE : binary,
    resources,
    nodes:
      platform === 'win32'
        ? [
            path.join(
              resources,
              'runtime/primary-runtime/dependencies/node/node.exe',
            ),
            path.join(
              resources,
              'runtime/primary-runtime/dependencies/node/bin/node.exe',
            ),
          ]
        : [
            path.join(
              resources,
              'runtime/primary-runtime/dependencies/node/bin/node',
            ),
          ],
  };
}

export function stateDirectory(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  const path = platform === 'win32' ? win32 : posix;
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : platform === 'win32'
        ? env.LOCALAPPDATA || path.join(home, 'AppData/Local')
        : env.XDG_STATE_HOME || path.join(home, '.local/state');
  return path.join(base, 'dsh-sidebar-browser-control');
}

export function processIdentity(record) {
  return {
    ...record,
    key: createHash('sha256')
      .update(`${record.pid}:${record.started}`)
      .digest('hex'),
    restarted: record.command
      .split(/\s+/)
      .some(
        (arg) => arg === RESTART_FLAG || arg.startsWith(RESTART_FLAG + '='),
      ),
  };
}

export async function inspectProcess(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Invalid desktop PID');
  if (platform === 'win32') {
    const { stdout } = await powershell(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { @{pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; started=$p.CreationDate.ToUniversalTime().ToString('o'); binary=$p.ExecutablePath; command=$p.CommandLine} | ConvertTo-Json -Compress }`,
    );
    return stdout.trim() ? processIdentity(JSON.parse(stdout)) : null;
  }
  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return processIdentity({
        pid,
        parent: Number(fields[1]),
        started: `${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${fields[19]}`,
        binary: await readlink(`/proc/${pid}/exe`),
        command: (await readFile(`/proc/${pid}/cmdline`, 'utf8'))
          .replaceAll('\0', ' ')
          .trim(),
      });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
      throw error;
    }
  }
  if (platform !== 'darwin') throw new Error('Unsupported desktop platform');
  let stdout;
  try {
    ({ stdout } = await exec(
      '/bin/ps',
      ['-p', String(pid), '-o', 'ppid=,lstart=,command='],
      { timeout: 5000 },
    ));
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
  const match = stdout.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/m);
  if (!match) return null;
  const { stdout: executable } = await exec(
    '/bin/ps',
    ['-p', String(pid), '-o', 'comm='],
    { timeout: 5000 },
  );
  return processIdentity({
    pid,
    parent: Number(match[1]),
    started: match[2],
    command: match[3],
    binary: executable.trim(),
  });
}

export async function discoverDesktop({
  pid = process.ppid,
  platform = process.platform,
  env = process.env,
  inspect = inspectProcess,
  exists = access,
} = {}) {
  for (let depth = 0; pid > 1 && depth < 12; depth++) {
    const record = await inspect(pid, platform);
    if (!record) break;
    if (
      record.binary &&
      /(?:deepseek[ -]?harness|dsh)(?:\.exe)?$/i.test(record.binary) &&
      !/(?:--type=|--expose-internals|auto-restart\.mjs)/.test(record.command)
    ) {
      const paths = installation(record.binary, platform, env);
      await exists(paths.resources);
      for (const node of paths.nodes) {
        try {
          await exists(node);
          return { ...paths, pid: record.pid, key: record.key, node, platform };
        } catch {}
      }
      throw new Error('DSH bundled Node runtime was not found.');
    }
    pid = record.parent;
  }
  throw new Error('Could not identify the parent DSH desktop installation.');
}

export async function requestQuit(desktop) {
  if (desktop.platform === 'darwin') {
    await exec(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'tell application (item 1 of argv) to quit',
        '-e',
        'end run',
        desktop.app,
      ],
      { timeout: 15000 },
    );
  } else if (desktop.platform === 'win32') {
    // WM_CLOSE allows DSH to refuse closure or show its normal confirmation.
    await powershell(
      `$p = Get-Process -Id ${desktop.pid} -ErrorAction Stop; [void]$p.CloseMainWindow()`,
    );
  }
  // Linux has no universal graceful close API (X11/Wayland). Wait for normal
  // user Quit instead of sending a signal that bypasses DSH's shutdown checks.
}

export async function launchDesktop(desktop, flags) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (desktop.platform === 'darwin') {
    await exec('/usr/bin/open', ['-a', desktop.app, '--args', ...flags], {
      env,
    });
    return;
  }
  // AppImage's mounted executable disappears on exit; launch the original file.
  if (desktop.launcher !== desktop.binary) {
    for (const key of ['APPIMAGE', 'APPDIR', 'OWD']) delete env[key];
  }
  const child = spawn(desktop.launcher, flags, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
    cwd: homedir(),
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

// Injectable clock and inspector keep restart refusal/PID-reuse tests deterministic.
export async function waitForExit(
  original,
  {
    inspect = inspectProcess,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeout = 300000,
  } = {},
) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    const current = await inspect(original.pid);
    if (!current) return;
    if (current.key !== original.key)
      throw new Error('Desktop process identity changed; restart skipped.');
    await sleep(500);
  }
  throw new Error(
    'DSH did not quit within five minutes; restart cancelled without forcing shutdown.',
  );
}
