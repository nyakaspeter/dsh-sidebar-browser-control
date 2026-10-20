# DSH Sidebar Browser Control

Let DeepSeek Harness agents browse in the background and show pages in the sidebar when needed. Agents can also control manually opened browser tabs in their chat.

**Experimental · DSH Desktop 0.2.0-rc.2 or newer (tested through 0.2.1-rc.2)**

Startup supports macOS, Windows, and Linux. Desktop integration has been tested on macOS; Windows/Linux still need real-app validation.

## Install

In **Plugins → Add plugin**, paste the GitHub repository URL:

```text
https://github.com/nyakaspeter/dsh-sidebar-browser-control
```

Enable the plugin, then fully quit and reopen DSH. Launch DSH normally—no terminal setup, path settings, or build step is needed. The plugin detects the running installation and its bundled runtime. It may relaunch DSH once to enable local debugging; it does not modify the app bundle.

On Linux, quit DSH normally when browser setup is pending; the helper reopens it automatically. On Windows, do the same if closing the window leaves DSH in the tray. The pending restart expires after five minutes and never force-quits the app.

DSH has no plugin auto-update. When a newer GitHub release exists, the plugin's page in **Plugins** shows an **Update available** tag next to the version (checked at most once a day; click it to open the release). To update, add the repository URL again in **Plugins → Add plugin**, then fully quit and reopen DSH.

### DSH updates

The plugin declares `engines.dsh >=0.2.0-rc.2`, so DSH updates no longer block it. It depends on some undocumented DSH internals; if a release changes them, `status` reports `DSH_INCOMPATIBLE` or a diagnostics warning instead of failing silently.

## Use

Ask naturally:

> Open example.org in the background and summarize it.
>
> Show me that tab.
>
> Fill in the form in my existing browser tab.

Agents discover the `sidebar_browser` tool automatically. It supports reading pages (including cross-origin frames), clicking, typing, keypresses, scrolling, dragging, uploads, downloads, screenshots, and page debugging. Detailed instructions are available to the agent through `help`.

- Requests like “open Google News” or “show me that page” reveal the sidebar, including when you imply wanting to see it. Questions like “what’s the latest news on Google News?” use background browsing and get an answer in chat. Explicit background requests stay hidden. Revealing an existing page preserves its running state.
- Agents keep working when you switch chats. Each agent can access only its own chat’s tabs; that chat must remain loaded.
- Existing native tabs keep DSH’s toolbar. Background tabs use a matching plugin toolbar, including when revealed.
- Agent tabs use cookie storage private to their chat: tabs in one chat share it, but it is separate from other chats and from DSH’s own browser tabs, and it is cleared when DSH quits. Tabs you open yourself in DSH keep DSH’s storage.
- Uploads only accept files inside the chat’s working directory or its browser downloads folder. Downloads (up to 500 MB, streamed to disk) are saved to a per-chat folder in the plugin’s state directory: `~/Library/Application Support/dsh-sidebar-browser-control/downloads/` on macOS, `%LOCALAPPDATA%\dsh-sidebar-browser-control\downloads\` on Windows, `~/.local/state/dsh-sidebar-browser-control/downloads/` on Linux. DSH blocks the browser’s own downloads, so the plugin fetches files through the page with its cookies. Agents move them with their normal file tools.
- Reads are compact and paginated. Debug event collection starts only when requested.

## Tool actions

One tool, `sidebar_browser`, provides these actions. Page actions generally require a `tabId` from `open` or `list`; `help` describes the full parameters.

| Actions                          | Purpose                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `help`, `status`, `list`         | Instructions, readiness, and this chat’s tabs                     |
| `open`, `focus`, `hide`, `close` | Open pages and manage visibility or lifetime                      |
| `navigate`                       | Go to a URL, back, forward, or reload                             |
| `read`                           | Read page text and controls with temporary references             |
| `click`, `hover`, `drag`         | Interact using references, selectors, or coordinates              |
| `type`, `press`                  | Fill fields, select options, check boxes, and send keys/modifiers |
| `scroll`, `wait`                 | Scroll or wait for a condition, including network idle            |
| `dialog`                         | Inspect, accept, or dismiss JavaScript dialogs                    |
| `upload`, `download`             | Set files on file inputs; save links or URLs with page cookies    |
| `screenshot`                     | Capture the viewport, full page, or one element (PNG/JPEG)        |
| `evaluate`                       | Run JavaScript in the page                                        |
| `debug_start`, `debug_read`      | Collect and read bounded network/console events                   |
| `cdp`                            | Send a permitted page-level DevTools command (policy-checked)     |

## Security

The plugin’s DOM code runs in a separate JavaScript world, so pages can’t see or tamper with it. Raw `cdp` commands are limited to page-level domains. Commands that would bypass the tool’s own rules are refused: navigation and URL checks, screenshots, key routing, dialogs, uploads, downloads, cookie access across the storage partition, and closing the guest. The download fallback used when CORS blocks an in-page fetch refuses private and loopback addresses, and it looks up cookies separately for each redirect.

Local debugging listens on a random loopback port. The plugin finds it through Chromium’s `DevToolsActivePort` file and checks the browser ID before connecting, so a stale file or another process on that port is rejected. Any local process can still reach the debugging endpoint while DSH runs, and that endpoint gives broad control of the app. Website content is untrusted, and debug output may contain sensitive page data. To remove the integration and debugging flags, disable or uninstall the plugin, then quit and reopen DSH normally.

## Limitations

Screenshots of background plugin tabs work while DSH is behind other windows. They are impossible while DSH is minimized (Chromium draws nothing; tested, including capturing the main window) and for native DSH tabs that are not on screen, which report `TAB_HIDDEN` immediately instead of timing out. Agents continue with page reads instead. Showing screenshots requires an image-capable model and compatible attachment storage.

The plugin uses internal DSH APIs that may change with app updates. Browser state is temporary. Reloading the plugin discards its own pages; native tabs remain owned by DSH. Selectors don’t reach into cross-origin frames (use the `f<n>:` refs from `read` instead), and dragging between frames isn’t supported. Browser permission dialogs aren’t supported, and DSH itself cancels native downloads.

## Development

Requires Node.js 22+:

```sh
npm ci
npm test
npm run format:check
npm run check:dsh   # verify the installed DSH still has every integration point
```

See [development notes](docs/development.md) for architecture, local installation, diagnostics, and live tests.

[ISC license](LICENSE)
