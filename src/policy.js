// Raw `cdp` commands are limited to page-level domains, minus methods that
// bypass the tool's own safeguards (URL policy, upload scoping, screenshot
// bounds, guest input routing, dialog handling) or touch partition-wide state.
const DOMAINS =
  /^(Accessibility|DOM|DOMSnapshot|CSS|Runtime|Network|Page|Input|Log|Performance|Debugger|Overlay|Animation|LayerTree)\.[A-Za-z]+$/;
const ROUTED = {
  'Page.navigate': 'navigate',
  'Page.navigateToHistoryEntry': 'navigate mode:back/forward',
  'Page.reload': 'navigate mode:reload',
  'Page.captureScreenshot': 'screenshot',
  'Page.startScreencast': 'screenshot',
  'Page.screencastFrameAck': 'screenshot',
  'Page.handleJavaScriptDialog': 'dialog',
  'Input.dispatchKeyEvent': 'press',
  'DOM.setFileInputFiles': 'upload',
  'Page.setDownloadBehavior': 'download',
};
const DENIED = new Set([
  // Guest lifetime belongs to DSH and the plugin's lease bookkeeping.
  'Page.close',
  'Page.crash',
  'Page.resetNavigationHistory',
  'Page.setWebLifecycleState',
  // Cookies and caches are shared by every tab in the storage partition,
  // including the user's signed-in native tabs.
  'Network.getCookies',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Network.loadNetworkResource',
  'Network.setCookieControls',
  'Network.clearAcceptedEncodingsOverride',
]);
export function checkCdpCommand(method, params = {}) {
  if (typeof method !== 'string' || !DOMAINS.test(method))
    throw new Error(
      'Unsupported CDP domain; browser/application target control is excluded',
    );
  if (ROUTED[method])
    throw new Error(
      `Use the ${ROUTED[method]} action for ${method}; it applies DSH guest routing, URL policy and bounded failure handling.`,
    );
  if (DENIED.has(method))
    throw new Error(
      `${method} is not permitted through cdp: it affects DSH-owned state or every tab sharing this browser storage.`,
    );
  if (method === 'Page.createIsolatedWorld' && params.grantUniveralAccess)
    throw new Error('Isolated worlds with universal access are not permitted.');
  return params;
}
export function parseCdpParams(text) {
  if (text === undefined || text === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('params must be a JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('params must be a JSON object');
  return value;
}
