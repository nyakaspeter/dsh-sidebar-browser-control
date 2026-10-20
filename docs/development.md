# Development

## Structure

- `src/index.js`: tool registration, input schema, cookie setting, and output integration.
- `src/client.js`: sidebar registration, persistent webviews, native-tab discovery, toolbar, and plugin settings.
- `src/controller.js`: chat ownership, command dispatch, per-chat queues, and connection lifecycle.
- `src/cdp.js`: loopback transport, cancellation, dialog tracking, and bounded debug buffers.
- `src/page-dom.js`, `src/interactions.js`: DOM snapshots, references, and input actions.
- `src/screenshot.js`, `src/image-output.js`: bounded capture and DSH image attachments.
- `src/autostart.js`, `src/desktop.js`, `scripts/auto-restart.mjs`: normal-launch debugging setup.
- `src/compatibility.js`, `src/help.js`: build checks and on-demand tool guidance.

Client code runs in DSH’s module loader; host code runs as an ESM plugin. No build step is needed. Keep the client build literals synchronized with `package.json`; the compatibility test checks this.

## Integration constraints

A plugin-owned webview keeps a stable DOM parent. Revealing it positions its existing container over the sidebar viewport; moving the guest between parents can destroy it. Layout and toolbar updates are event-driven.

Native tabs remain owned by DSH. Do not release their leases on plugin unload. Native opening expands the sidebar and may not initialize a guest in an off-screen chat, so background creation uses plugin-owned pages.

Route keyboard input and reload/back/forward through the guest webview methods. Direct CDP key dispatch and history/reload commands affected the main DSH window during integration testing. Do not use native `capturePage`: it caused an Electron crash. Keep screenshot failures bounded and require explicit user-requested retries.

The integration uses some undocumented session-specific sidebar APIs and webview attributes. `engines.dsh` is an open range (`>=0.2.0-rc.2`), so DSH does not block the plugin on updates; DSH ignores the `@deepseek-ai/dsh-*` peers when `engines.dsh` is present. Never pin those peers to an exact version. The client reports missing APIs as `DSH_INCOMPATIBLE` instead of failing silently, so after a DSH release run `npm run doctor` and the live tests, then update the tested version in the README. Avoid dumping application logs: they can contain credentials.

## Live tests

Enable the plugin, run `npm run doctor`, and select a disposable test chat. These checks open local fixture pages and do not require model calls. Some reveal tabs or interact with the sidebar; run them while DSH is idle.

```sh
npm run test:live
```

This runs interaction and compact-read regression checks. Additional checks:

| Command                                                 | Coverage                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `node scripts/concurrency-test.mjs SESSION_A SESSION_B` | Repeated background operations and ownership isolation         |
| `node scripts/queue-test.mjs SESSION_A SESSION_B`       | Another chat can read while one chat waits                     |
| `node scripts/consent-fixture.mjs`                      | Local page for manual agent cookie/screenshot acceptance tests |
| `node scripts/profile.mjs`                              | macOS app-wide CPU/RSS samples with three local pages          |

For two-chat checks, open each test chat once after starting DSH so both are loaded. Use their actual session IDs. Fixture scripts clean up their own tabs; the consent fixture runs until stopped. Profiling measures the entire app, not isolated plugin overhead.

Check manually that background opens leave the sidebar unchanged, reveal preserves form/page state, native tabs retain their toolbar, and minimized screenshot failures do not trigger retries. Verify the cookie switch and an actual agent turn after changes to tool guidance or attachment output.

## Packaging

`npm pack --dry-run` should include source, the automatic-restart helper, README, license, package metadata, and the Cordis patch. Tests, development fixtures, CI, and development docs remain in GitHub but are excluded from the installed archive.

After installing a new archive, fully quit/reopen DSH to reload host and client code. Test output from a previous installed version does not validate changed source.

## Local installation and diagnostics

Requires Node.js 22 or newer. Run `npm ci`, `npm test`, and `npm pack`, then install the generated `.tgz` through DSH’s Add plugin dialog. Fully quit/reopen after upgrading. Run `npm run doctor` to check the connection and host/client build match.

Startup discovers the parent DSH process and bundled Node runtime, using loopback port 19222. macOS uses the detected app bundle; Windows uses the detected executable; Linux preserves the original AppImage path when available. There are no custom launcher or environment settings. The helper makes at most one normal-restart attempt per manual app launch, with an atomic claim to prevent duplicates and a launch marker to prevent loops. It never force-quits DSH. Linux waits for normal user Quit; Windows requests window close but may also need Quit when DSH remains in the tray. The helper expires after five minutes. Failure diagnostics live in the platform state directory: macOS Application Support, Windows LocalAppData, or Linux XDG state home, under `dsh-sidebar-browser-control`. Unit tests run on all three OSes in CI; only macOS desktop integration has been locally validated.
