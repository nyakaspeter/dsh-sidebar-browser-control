import metadata from '../package.json' with { type: 'json' };
export const BUILD = metadata.version;
export const PROTOCOL = 2;
export function compatibility(client) {
  if (!client)
    return {
      ok: false,
      code: 'BROWSER_UNAVAILABLE',
      retryable: false,
      message:
        'The sidebar plugin client is not loaded. Check that the plugin is enabled. Do not retry browser actions in a loop.',
    };
  if (client.compatibilityError)
    return {
      ok: false,
      code: 'DSH_INCOMPATIBLE',
      retryable: false,
      message: `This DSH version lacks required browser APIs: ${client.compatibilityError}. Update the plugin for this DSH version. Do not retry or restart in a loop.`,
    };
  if (client.version !== PROTOCOL || client.build !== BUILD)
    return {
      ok: false,
      code: 'PLUGIN_VERSION_MISMATCH',
      retryable: false,
      message: `Browser plugin host ${BUILD} and client ${client.build ?? 'unknown'} are incompatible. Fully quit and reopen DSH once after updating. If it persists, update/reinstall the plugin; do not repeatedly restart.`,
    };
  return null;
}
