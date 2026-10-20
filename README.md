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

Updates require reinstalling and fully restarting DSH; they are not automatic.

## Use

Ask naturally:

> Open example.org in the background and summarize it.
>
> Show me that tab.
>
> Fill in the form in my existing browser tab.

Agents discover the `sidebar_browser` tool automatically. It supports reading pages, clicking, typing, keypresses, scrolling, dragging, screenshots, and page debugging. Detailed instructions are available to the agent through `help`.

- Requests like “open Google News” or “show me that page” reveal the sidebar, including when you imply wanting to see it. Questions like “what’s the latest news on Google News?” use background browsing and get an answer in chat. Explicit background requests stay hidden. Revealing an existing page preserves its running state.
- Agents keep working when you switch chats. Each agent can access only its own chat’s tabs; that chat must remain loaded.
- Existing native tabs keep DSH’s toolbar. Background tabs use a matching plugin toolbar, including when revealed.
- Cookie handling defaults to rejecting optional cookies and preserving existing choices. Disable it under **Plugins → dsh-sidebar-browser-control → Automatically handle cookie consent**. This is agent guidance, not an independent banner-clicking script.
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
| `scroll`, `wait`                 | Scroll or wait for a page condition                               |
| `dialog`                         | Inspect, accept, or dismiss JavaScript dialogs                    |
| `screenshot`                     | Capture the page with bounded failure handling                    |
| `evaluate`                       | Run JavaScript in the page                                        |
| `debug_start`, `debug_read`      | Collect and read bounded network/console events                   |
| `cdp`                            | Send a permitted page-level DevTools command                      |

## Limitations

Screenshots can fail when DSH is hidden or minimized. Failures are bounded; agents are instructed to continue with page reads rather than retrying. Showing screenshots requires an image-capable model and compatible attachment storage.

The plugin expects one DSH window and uses internal APIs that may change with app updates. Browser state is temporary. Reloading the plugin discards its own pages; native tabs remain owned by DSH. Cross-origin frame traversal, uploads/downloads, and browser permission dialogs are not generally supported.

Local debugging uses `127.0.0.1:19222` and grants broad app access to local processes. Website content is untrusted, and debug output may contain sensitive page data. To remove the integration and debugging flags, disable/uninstall the plugin, then quit and reopen DSH normally.

## Development

Requires Node.js 22+:

```sh
npm ci
npm test
npm run format:check
```

See [development notes](docs/development.md) for architecture, local installation, diagnostics, and live tests.

[ISC license](LICENSE)
