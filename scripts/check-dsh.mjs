// Checks an installed DSH build for the internal APIs and markup this plugin
// depends on. Run after every DSH release: npm run check:dsh [path/to/app.asar]
import asar from '@electron/asar';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const defaults = {
  darwin: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  win32: join(
    process.env.LOCALAPPDATA ?? '',
    'Programs/DeepSeek Harness/resources/app.asar',
  ),
};
const archive = process.argv[2] ?? defaults[process.platform];
if (!archive || !existsSync(archive)) {
  console.error(
    'DSH app.asar not found. Pass its path: npm run check:dsh -- /path/to/app.asar',
  );
  process.exit(2);
}
const read = (path) => {
  try {
    return asar.extractFile(archive, join(...path.split('/'))).toString('utf8');
  } catch {
    return null;
  }
};
const pkg = (name, file) =>
  read(`dsh/node_modules/@deepseek-ai/${name}/${file}`);

// Prerelease-aware comparison for the plugin's ">=X" engines range.
function compare(a, b) {
  const split = (v) => {
    const [core, pre] = v.split('-');
    return [core.split('.').map(Number), pre];
  };
  const [[x, xp], [y, yp]] = [split(a), split(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (xp === yp) return 0;
  if (!xp) return 1;
  if (!yp) return -1;
  return xp.localeCompare(yp, 'en', { numeric: true });
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const runtime = JSON.parse(pkg('dsh-app-boot', 'package.json') ?? '{}').version;
const minimum = /^>=\s*(\S+)$/.exec(manifest.engines.dsh)?.[1];

const files = {
  boot: pkg('dsh-app-boot', 'lib/index.js'),
  right: pkg('dsh-client-ui-sidebar-right', 'lib/client.js'),
  browser: pkg('dsh-client-ui-sidebar-browser', 'lib/client.js'),
  tools: pkg('dsh-tools', 'lib/index.js'),
  preload: read('lib/preload-app.cjs'),
  main: read('lib/main.js'),
};
const checks = [
  ['DSH runtime version is readable', () => !!runtime],
  [
    `engines.dsh ${manifest.engines.dsh} admits DSH ${runtime}`,
    () => !!minimum && compare(runtime, minimum) >= 0,
  ],
  [
    'loader evaluates engines.dsh instead of peers',
    () => files.boot?.includes('Object.hasOwn(engines, "dsh")'),
  ],
  ...[
    'tabsIn(sessionId)',
    'openTabIn(sessionId, kind',
    'closeIn(sessionId, tabId)',
    'actionsFor(sessionId)',
    'isExpanded()',
    'active()',
    'this.mounted =',
    'this.openTabs =',
    'focusTab:',
    'setExpanded:',
    'data-sidebar-right-session',
    'data-sidebar-right-tab',
    '"sidebar.right.pane.tab"',
    '"sidebar.right.pane.tab.title"',
    'useTabInfo',
    'keepMounted',
  ].map((s) => [`sidebar service: ${s}`, () => files.right?.includes(s)]),
  ...[
    'dataset.sidebarBrowserFrame = "webview"',
    'bridge.acquire(',
    'onOpenRequested(',
    'setAttribute("name", reservation.lease)',
    '"about:blank#" + reservation.lease',
    '`cwd:${workspace.path}`',
    '`session:${sessionId}`',
    'protocolVersion === 1',
  ].map((s) => [`native browser: ${s}`, () => files.browser?.includes(s)]),
  ...[
    'protocolVersion: 1',
    'browser: createDesktopBrowserBridge()',
    'webview[data-sidebar-browser-frame]',
  ].map((s) => [`desktop preload: ${s}`, () => files.preload?.includes(s)]),
  ...['will-attach-webview', 'about:blank#', 'dsh-desktop:browser-acquire'].map(
    (s) => [`desktop main: ${s}`, () => files.main?.includes(s)],
  ),
  ['tool API: defineTool', () => files.tools?.includes('function defineTool(')],
];

let failed = 0;
console.log(`DSH ${runtime ?? 'unknown'} (${archive})`);
for (const [label, test] of checks) {
  const ok = !!test();
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}`);
}
console.log(
  failed
    ? `\n${failed} check(s) failed: update the plugin for this DSH release before relying on it.`
    : '\nAll DSH integration points are present. Run npm run doctor and npm run test:live to confirm behavior.',
);
process.exitCode = failed ? 1 : 0;
