import { compatibility, BUILD } from '../src/compatibility.js';
import { CDP, endpoint, targets } from '../src/cdp.js';
const base = endpoint();
try {
  const all = await targets(base),
    app = all.find((t) => t.url === 'dsh-app://app/');
  if (!app) throw new Error('DSH application target not found');
  const c = await CDP.connect(app.webSocketDebuggerUrl, base);
  try {
    const pluginClient = await c.evaluate(
      'window.__dshSidebarControl?.status?.() ?? null',
    );
    const problem = compatibility(pluginClient);
    if (problem) process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          endpoint: base,
          application: true,
          hostBuild: BUILD,
          pluginClient,
          ...(problem ?? { ok: true }),
          sidebarTargets: all.filter(
            (t) => t.type === 'webview' && t.parentId === app.id,
          ).length,
        },
        null,
        2,
      ),
    );
  } finally {
    c.close();
  }
} catch (e) {
  console.error(
    `Not ready: ${e.message}. Enable the plugin, then fully quit and reopen DSH.`,
  );
  process.exitCode = 1;
}
