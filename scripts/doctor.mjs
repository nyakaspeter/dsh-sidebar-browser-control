import { compatibility, BUILD } from '../src/compatibility.js';
import { CDP, targets } from '../src/cdp.js';
import { discoverEndpoint } from '../src/endpoint.js';
try {
  const base = await discoverEndpoint();
  if (!base)
    throw new Error(
      'no verified DevToolsActivePort endpoint (DSH was not launched with debugging)',
    );
  const all = await targets(base),
    apps = all.filter((t) => t.url === 'dsh-app://app/' && t.type === 'page');
  if (!apps.length) throw new Error('DSH application target not found');
  for (const app of apps) {
    const c = await CDP.connect(app.webSocketDebuggerUrl, base);
    try {
      const pluginClient = await c.evaluate(
        'window.__dshSidebarControl?.status?.() ?? null',
      );
      const problem = compatibility(pluginClient);
      if (problem || pluginClient?.diagnostics?.warnings?.length)
        process.exitCode = 1;
      console.log(
        JSON.stringify(
          {
            endpoint: base,
            window: app.id,
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
  }
} catch (e) {
  console.error(
    `Not ready: ${e.message}. Enable the plugin, then fully quit and reopen DSH.`,
  );
  process.exitCode = 1;
}
