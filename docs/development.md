# Development

## Structure

- `src/args.js`: the 12-parameter public schema and its mapping onto internal arguments.
- `src/format.js`: plain-text rendering of read, find and logs results.
- `src/logs.js`: bounded per-tab console and request recording.
- `src/index.js`: tool registration, input schema, settings, update notices and output integration.
- `src/client.js`: runs in DSH's renderer. Sections: compatibility and markup diagnostics, update badge, page registry and agent API, layout, tab title/toolbar.
- `src/controller.js`: chat ownership, per-chat queues, window routing, target discovery caching and action dispatch (read, upload, download, screenshot, network idle).
- `src/frames.js`: isolated worlds, cross-origin frame discovery (in-process and out-of-process via flattened auto-attach), frame offsets and frame-qualified refs.
- `src/cdp.js`, `src/endpoint.js`: loopback transport with child sessions and event subscriptions; `DevToolsActivePort` discovery and verification.
- `src/page-dom.js`, `src/interactions.js`, `src/read.js`: in-page DOM snapshots and actions, input dispatch, cross-frame read pagination.
- `src/transfer.js`: download naming and streaming to disk, upload path confinement.
- `src/screenshot.js`, `src/image-output.js`: bounded capture and DSH image attachments.
- `src/autostart.js`, `src/desktop.js`, `src/restart.js`, `scripts/auto-restart.mjs`: normal-launch debugging setup; `restart.js` holds the testable restart flow.
- `src/compatibility.js`, `src/help.js`: build checks and sectioned agent guidance.

Client code runs in DSH's module loader as a single file; there is no build step. Keep the client `BUILD` literal synchronized with `package.json`; the compatibility test checks this.

## Context budget

The tool definition is sent with every model request, so it is kept to about 480 tokens: 12 parameters, with per-action variants in `mode` and string inputs in `text` (see `src/args.js`). Details live in `help`. Large results (read, find, logs) are plain text rather than JSON. A test fails if the definition or help grows past its budget; raise those limits only deliberately.

## Integration constraints

A plugin-owned webview keeps a stable DOM parent. Revealing it positions its existing container over the sidebar viewport; moving the guest between parents can destroy it. Layout and toolbar updates are event-driven.

Native tabs remain owned by DSH. Do not release their leases on plugin unload. Native opening expands the sidebar and may not initialize a guest in an off-screen chat, so background creation uses plugin-owned pages.

Route keyboard input and reload/back/forward through the guest webview methods. Direct CDP key dispatch and history/reload commands affected the main DSH window during integration testing. Do not use native `capturePage`: it caused an Electron crash. Keep screenshot failures bounded and require explicit user-requested retries.

Plugin DOM code runs in a CDP isolated world (`Page.createIsolatedWorld`), never in the page's main world; only the user-facing `evaluate` action uses the main world. Out-of-process frames only receive mouse input sent to their own session, in coordinates relative to that session's root frame. Chromium produces no frames for `opacity: 0` layers, so screenshots of parked pages briefly raise the container to `0.01` opacity.

Network-idle tracking counts the main document and main-frame-session requests only: an out-of-process iframe's document request starts in the parent session but finishes in the iframe's own session, sometimes before tracking reaches it. Child sessions are registered on the CDP connection itself so modules that start late still adopt them.

Plugin tabs acquire storage with a per-chat key (`dsh-sidebar-control:<session>`), never DSH's workspace keys, so they never see the user's sign-ins.

The integration uses some undocumented session-specific sidebar APIs and webview attributes. `engines.dsh` is an open range (`>=0.2.0-rc.2`), so DSH does not block the plugin on updates; DSH ignores the `@deepseek-ai/dsh-*` peers when `engines.dsh` is present. Never pin those peers to an exact version. The client reports missing APIs as `DSH_INCOMPATIBLE` instead of failing silently, so after a DSH release run `npm run doctor` and the live tests, then update the tested version in the README. Avoid dumping application logs: they can contain credentials.

## After a DSH release

1. `npm run check:dsh` reads the installed `app.asar` and verifies every API, markup string and storage-key format the plugin depends on.
2. `npm run doctor` with the plugin enabled checks the running app, including client diagnostics warnings.
3. `npm run test:live` in a disposable chat.
4. Update the tested version in the README.

## Releasing

Bump `version` in `package.json` and the client `BUILD` literal, commit, then push a `vX.Y.Z` tag. The release workflow tests, checks that the tag matches the version, and attaches the packed `.tgz` to a GitHub release. Installed plugins learn about it through the daily update check.

## Live tests

Enable the plugin, run `npm run doctor`, and select a disposable test chat. These checks open local fixture pages and do not require model calls. Some reveal tabs or interact with the sidebar; run them while DSH is idle.

```sh
npm run test:live
```

This runs interaction, compact-read and feature checks. The feature check goes through the tool interface and covers isolated worlds against a page that monkeypatches DOM APIs, main-content reads, find, in-process and out-of-process cross-origin frames, logs from the first load, HTML5 drag-and-drop, upload, download, screenshot modes and network idle.

Fixture scripts clean up their own tabs.

Check manually that background opens leave the sidebar unchanged, reveal preserves form/page state, native tabs retain their toolbar, and minimized screenshot failures do not trigger retries. Verify an actual agent turn after changes to tool guidance or attachment output.

## Packaging

`npm pack --dry-run` should include source, the automatic-restart helper, README, license, package metadata, and the Cordis patch. Tests, development fixtures, CI, and development docs remain in GitHub but are excluded from the installed archive.

After installing a new archive, fully quit/reopen DSH to reload host and client code. Test output from a previous installed version does not validate changed source.

## Local installation and diagnostics

Requires Node.js 22 or newer. Run `npm ci`, `npm test`, and `npm pack`, then install the generated `.tgz` through DSH’s Add plugin dialog. Fully quit/reopen after upgrading. Run `npm run doctor` to check the connection and host/client build match.

Startup discovers the parent DSH process and bundled Node runtime. DSH is relaunched with `--remote-debugging-port=0`; the plugin reads the port from `DevToolsActivePort` in DSH's Electron user-data directory and verifies the browser socket path before use. macOS uses the detected app bundle; Windows uses the detected executable; Linux preserves the original AppImage path when available. There are no custom launcher or environment settings. The helper makes at most one normal-restart attempt per manual app launch, with an atomic claim to prevent duplicates and a launch marker to prevent loops. If DSH is already running again when the original process exits (the user reopened it), the helper does not launch another instance; that launch's own plugin handles its restart. Success is only recorded when a DSH process started with the restart flag is running and its endpoint still verifies after a settle period, because a second launch that hands off to an existing instance can publish a port briefly before exiting. It never force-quits DSH. Linux waits for normal user Quit; Windows requests window close but may also need Quit when DSH remains in the tray. The helper expires after five minutes. Failure diagnostics live in the platform state directory: macOS Application Support, Windows LocalAppData, or Linux XDG state home, under `dsh-sidebar-browser-control`. Unit tests run on all three OSes in CI; only macOS desktop integration has been locally validated.
