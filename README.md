# DSH browser debugging

A DeepSeek Harness (DSH) bundle that gives the agent Codex-style browser debugging through two MCP tool sets.

| Tool prefix | What it drives | How |
|---|---|---|
| `mcp__chrome__*` | Your own running Chrome: real tabs, logged-in sessions | The **DSH Browser Bridge** extension (`chrome.debugger`) talks to `server/bridge.mjs` over `ws://127.0.0.1:17321/ext`. The server accepts connections only from the extension's origin. |
| `mcp__browser__*` | A separate Chrome profile (`~/.dsh/browser-devtools/chrome-profile`) | Google's [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) |

```
DSH agent ──MCP stdio──> server/bridge.mjs ──WebSocket──> extension ──CDP──> your tabs
```

## `mcp__chrome__*` tools

`list_tabs`, `select_tab`, `new_tab`, `activate_tab`, `close_tab`, `detach_tab`, `navigate`, `take_snapshot`, `take_screenshot`, `click`, `click_at`, `hover`, `fill`, `type_text`, `press_key`, `scroll`, `evaluate_script`, `wait_for`, `list_console_messages`, `list_network_requests`, `get_network_request`, `cdp_send` (sends any raw CDP command)

Console and network capture starts when a tab is attached, so reload the page to see load-time events. While a tab is attached, Chrome shows its "is debugging this browser" bar; `detach_tab` removes it.

## Install

1. Install dependencies:
   ```
   cd server
   npm install
   ```
2. Edit the absolute paths in `cordis.patch.yml` (`node.exe`, `bridge.mjs`, `chrome-devtools-mcp.js`, `--userDataDir`) to match your machine.
3. Install the bundle in DSH: **Plugins** > **Add plugin** and choose this directory, or call `plugin_manager install_bundle` with the absolute path.
4. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder. The toolbar badge shows **ON** once the extension is connected.

`ext-key.json` holds the extension's public key, which keeps its ID fixed at `hhmgbijaimmoghgkilbobnpeoehfakbh`. The bridge accepts WebSocket connections only from that origin. To use your own key, regenerate `ext-key.json`, then run `node server/make-manifest.mjs`.

## Privacy

The model receives the contents of any page the tools read. The `mcp__chrome__*` tools act inside your own logged-in sessions.
