# DSH 浏览器调试 / DSH Browser Debugging

[中文](#中文) · [English](#english)

## 中文

这是一个 DeepSeek Harness（DSH）插件，提供两组 MCP 工具，让智能体像使用 Codex 一样调试浏览器。

| 工具前缀 | 调试对象 | 连接方式 |
|---|---|---|
| `mcp__chrome__*` | 你正在使用的 Chrome，包括已打开的标签页和登录会话 | **DSH Browser Bridge** 扩展通过 `chrome.debugger` 调试页面，并通过 `ws://127.0.0.1:17321/ext` 连接 `server/bridge.mjs`。桥接服务只接受来自该扩展来源的连接。 |
| `mcp__browser__*` | 使用独立配置目录（`~/.dsh/browser-devtools/chrome-profile`）的 Chrome | Google 的 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) |

```text
DSH 智能体 ──MCP stdio──> server/bridge.mjs ──WebSocket──> 扩展 ──CDP──> Chrome 标签页
```

### `mcp__chrome__*` 工具

`list_tabs`, `select_tab`, `new_tab`, `activate_tab`, `close_tab`, `detach_tab`, `navigate`, `take_snapshot`, `take_screenshot`, `click`, `click_at`, `hover`, `fill`, `type_text`, `press_key`, `scroll`, `evaluate_script`, `wait_for`, `list_console_messages`, `list_network_requests`, `get_network_request`, `cdp_send`（发送原始 CDP 命令）

桥接服务与标签页建立调试连接后，才开始记录控制台消息和网络请求。要查看页面加载时的事件，请在连接后刷新页面。调试期间，Chrome 会显示调试提示条，调用 `detach_tab` 可断开连接并关闭提示条。

### 安装

使用 `chrome-devtools-mcp` 支持的 Node.js 版本（20.x 至少为 20.19，22.x 至少为 22.12，或使用 23 及以上版本）。

1. 安装依赖。
   ```sh
   cd server
   npm ci
   ```
2. 将 `cordis.patch.yml` 中 `node.exe`、`bridge.mjs`、`chrome-devtools-mcp.js` 和 `--userDataDir` 的绝对路径改为本机路径。
3. 在 DSH 中打开 **Plugins** > **Add plugin** 并选择仓库根目录，也可以将该目录的绝对路径传给 `plugin_manager install_bundle`。
4. 在 Chrome 中打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**，选择 `extension` 目录。连接后，扩展工具栏图标会显示 **ON**。

`ext-key.json` 保存扩展公钥，将扩展 ID 固定为 `hhmgbijaimmoghgkilbobnpeoehfakbh`。桥接服务只接受来自该扩展来源的 WebSocket 连接。如需使用自己的密钥，请重新生成 `ext-key.json`，然后运行 `node server/make-manifest.mjs`。

### 隐私

工具读取的页面内容会发送给模型。`mcp__chrome__*` 工具在你自己的 Chrome 登录会话中操作。

## English

A DeepSeek Harness (DSH) bundle that gives the agent Codex-style browser debugging through two MCP tool sets.

| Tool prefix | What it drives | How |
|---|---|---|
| `mcp__chrome__*` | Your own running Chrome: real tabs, logged-in sessions | The **DSH Browser Bridge** extension (`chrome.debugger`) talks to `server/bridge.mjs` over `ws://127.0.0.1:17321/ext`. The server accepts connections only from the extension's origin. |
| `mcp__browser__*` | A separate Chrome profile (`~/.dsh/browser-devtools/chrome-profile`) | Google's [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) |

```
DSH agent ──MCP stdio──> server/bridge.mjs ──WebSocket──> extension ──CDP──> your tabs
```

### `mcp__chrome__*` tools

`list_tabs`, `select_tab`, `new_tab`, `activate_tab`, `close_tab`, `detach_tab`, `navigate`, `take_snapshot`, `take_screenshot`, `click`, `click_at`, `hover`, `fill`, `type_text`, `press_key`, `scroll`, `evaluate_script`, `wait_for`, `list_console_messages`, `list_network_requests`, `get_network_request`, `cdp_send` (sends any raw CDP command)

Console and network capture starts when a tab is attached, so reload the page to see load-time events. While a tab is attached, Chrome shows its "is debugging this browser" bar; `detach_tab` removes it.

### Install

Use a Node.js version supported by the bundled `chrome-devtools-mcp` dependency (Node.js 20.19+ on the 20.x line, 22.12+ on the 22.x line, or 23+).

1. Install dependencies:
   ```sh
   cd server
   npm ci
   ```
2. Edit the absolute paths in `cordis.patch.yml` (`node.exe`, `bridge.mjs`, `chrome-devtools-mcp.js`, `--userDataDir`) to match your machine.
3. Install the bundle in DSH: **Plugins** > **Add plugin** and choose this directory, or call `plugin_manager install_bundle` with the absolute path.
4. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder. The toolbar badge shows **ON** once the extension is connected.

`ext-key.json` holds the extension's public key, which keeps its ID fixed at `hhmgbijaimmoghgkilbobnpeoehfakbh`. The bridge accepts WebSocket connections only from that origin. To use your own key, regenerate `ext-key.json`, then run `node server/make-manifest.mjs`.

### Privacy

The model receives the contents of any page the tools read. The `mcp__chrome__*` tools act inside your own logged-in sessions.
