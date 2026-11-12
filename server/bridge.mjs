// DSH Chrome bridge: an MCP stdio server that controls the user's own Chrome
// through the "DSH Browser Bridge" extension (chrome.debugger + local WebSocket),
// the same architecture Codex's Chrome plugin uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.DSH_BRIDGE_PORT || 17321);
const { id: EXTENSION_ID } = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'ext-key.json'), 'utf8').replace(/^\uFEFF/, ''),
);
const EXTENSION_DIR = path.join(ROOT, 'extension');
const MAX_BUFFER = 1000;
const MAX_SNAPSHOT_CHARS = 80000;

const log = (...a) => process.stderr.write(`[dsh-chrome-bridge] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- extension link
let ext = null;
let nextId = 1;
const pending = new Map();
const eventWaiters = new Set();
const tabState = new Map(); // tabId -> { console: [], network: Map, netOrder: [] }
let currentTab = null;

function state(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = { console: [], network: new Map(), netOrder: [], consoleSeq: 0, netSeq: 0 };
    tabState.set(tabId, s);
  }
  return s;
}

function pushBounded(arr, item) {
  arr.push(item);
  if (arr.length > MAX_BUFFER) arr.splice(0, arr.length - MAX_BUFFER);
}

function formatRemote(o) {
  if (!o) return '';
  if (o.type === 'string') return o.value;
  if ('value' in o) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview && o.preview.properties) {
    const props = o.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return o.subtype === 'array' ? `[${props}]` : `{${props}}`;
  }
  return o.description || o.type;
}

function onCdpEvent(tabId, method, params) {
  const s = state(tabId);
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const frame = params.stackTrace?.callFrames?.[0];
      pushBounded(s.console, {
        id: ++s.consoleSeq,
        level: params.type,
        text: (params.args || []).map(formatRemote).join(' '),
        source: frame ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : '',
        time: Date.now(),
      });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      pushBounded(s.console, {
        id: ++s.consoleSeq,
        level: 'exception',
        text: d.exception?.description || d.text || 'Uncaught exception',
        source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : '',
        time: Date.now(),
      });
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      pushBounded(s.console, {
        id: ++s.consoleSeq,
        level: e.level,
        text: `[${e.source}] ${e.text}`,
        source: e.url ? `${e.url}${e.lineNumber != null ? ':' + (e.lineNumber + 1) : ''}` : '',
        time: Date.now(),
      });
      break;
    }
    case 'Network.requestWillBeSent': {
      let r = s.network.get(params.requestId);
      if (!r) {
        r = { seq: ++s.netSeq, requestId: params.requestId };
        s.network.set(params.requestId, r);
        s.netOrder.push(params.requestId);
        if (s.netOrder.length > MAX_BUFFER) s.network.delete(s.netOrder.shift());
      }
      Object.assign(r, {
        url: params.request.url,
        method: params.request.method,
        requestHeaders: params.request.headers,
        postData: params.request.postData,
        type: params.type,
        started: Date.now(),
      });
      break;
    }
    case 'Network.responseReceived': {
      const r = s.network.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.statusText = params.response.statusText;
        r.mimeType = params.response.mimeType;
        r.responseHeaders = params.response.headers;
        r.type = params.type || r.type;
      }
      break;
    }
    case 'Network.loadingFinished': {
      const r = s.network.get(params.requestId);
      if (r) {
        r.finished = true;
        r.encodedDataLength = params.encodedDataLength;
        r.durationMs = Date.now() - r.started;
      }
      break;
    }
    case 'Network.loadingFailed': {
      const r = s.network.get(params.requestId);
      if (r) {
        r.failed = params.errorText || 'failed';
        r.canceled = params.canceled;
      }
      break;
    }
    case 'Page.frameNavigated':
      if (!params.frame.parentId) {
        // Keep history across navigations but mark the boundary.
        pushBounded(s.console, { id: ++s.consoleSeq, level: 'navigation', text: `Navigated to ${params.frame.url}`, source: '', time: Date.now() });
      }
      break;
    default:
  }
  for (const w of eventWaiters) {
    if (w.tabId === tabId && w.method === method && (!w.filter || w.filter(params))) {
      eventWaiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(params);
    }
  }
}

function waitEvent(tabId, method, timeoutMs, filter) {
  return new Promise((resolve) => {
    const w = { tabId, method, filter, resolve };
    w.timer = setTimeout(() => {
      eventWaiters.delete(w);
      resolve(null);
    }, timeoutMs);
    eventWaiters.add(w);
  });
}

function call(op, args = {}, timeoutMs = 30000) {
  if (!ext || ext.readyState !== 1) {
    return Promise.reject(
      new Error(
        `The DSH Browser Bridge extension is not connected. In Chrome open chrome://extensions, enable Developer mode, ` +
          `click "Load unpacked" and choose ${EXTENSION_DIR}. The toolbar badge shows ON once it is connected.`,
      ),
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for Chrome (${op}${args.method ? ' ' + args.method : ''}).`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, op, args }));
  });
}

const cdp = (tabId, method, params = {}, timeoutMs) => call('cdp', { tabId, method, params }, timeoutMs);

function startWsServer() {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: PORT,
    path: '/ext',
    verifyClient: ({ origin }) => origin === `chrome-extension://${EXTENSION_ID}`,
  });
  wss.on('listening', () => log(`listening on ws://127.0.0.1:${PORT}/ext`));
  wss.on('error', (e) => {
    log(`WebSocket server error: ${e.message}; retrying in 3 s`);
    setTimeout(startWsServer, 3000);
  });
  wss.on('connection', (sock) => {
    if (ext && ext !== sock) ext.close();
    ext = sock;
    tabState.clear();
    log('extension connected');
    const ping = setInterval(() => sock.readyState === 1 && sock.send(JSON.stringify({ type: 'ping' })), 20000);
    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'event') onCdpEvent(msg.tabId, msg.method, msg.params || {});
      else if (msg.type === 'detached' || msg.type === 'tabRemoved') {
        if (msg.type === 'tabRemoved') tabState.delete(msg.tabId);
        else if (tabState.has(msg.tabId)) tabState.get(msg.tabId).detached = msg.reason;
        if (currentTab === msg.tabId && msg.type === 'tabRemoved') currentTab = null;
      }
    });
    sock.on('close', () => {
      clearInterval(ping);
      if (ext === sock) {
        ext = null;
        log('extension disconnected');
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Chrome extension disconnected.'));
          pending.delete(id);
        }
      }
    });
  });
}

// ---------------------------------------------------------------- tab helpers
async function ensureAttached(tabId) {
  const s = state(tabId);
  const res = await call('attach', { tabId });
  if (!res.alreadyAttached || !s.enabled || s.detached) {
    s.detached = undefined;
    await Promise.all([
      cdp(tabId, 'Page.enable'),
      cdp(tabId, 'Runtime.enable'),
      cdp(tabId, 'Network.enable', { maxPostDataSize: 65536 }),
      cdp(tabId, 'Log.enable'),
      cdp(tabId, 'DOM.enable'),
    ]);
    s.enabled = true;
  }
}

async function resolveTab(tabId) {
  let id = tabId ?? currentTab;
  if (id == null) {
    const tabs = await call('listTabs');
    const active = tabs.find((t) => t.active && /^https?:|^file:/.test(t.url)) || tabs.find((t) => t.active);
    if (!active) throw new Error('No tab selected. Call list_tabs, then select_tab.');
    id = active.id;
  }
  await ensureAttached(id);
  currentTab = id;
  return id;
}

async function evaluate(tabId, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const r = await cdp(tabId, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || 'Evaluation failed');
  }
  return r.result;
}

// Accessibility-tree snapshot; uid = backendDOMNodeId.
const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);
async function snapshot(tabId, { verbose = false } = {}) {
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree', {}, 60000);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const lines = [];
  let chars = 0;
  let truncated = false;
  const visit = (n, depth) => {
    if (truncated) return;
    const role = n.role?.value || '';
    const name = (n.name?.value ?? '').toString().replace(/\s+/g, ' ').trim();
    if (role === 'InlineTextBox' && !verbose) return;
    const show =
      !n.ignored && (verbose || !(SKIP_ROLES.has(role) && !name)) && !(role === 'StaticText' && !name);
    let childDepth = depth;
    if (show) {
      const props = [];
      const val = n.value?.value;
      if (val !== undefined && val !== '') props.push(`value="${String(val).slice(0, 200)}"`);
      for (const p of n.properties || []) {
        const v = p.value?.value;
        if (['focused', 'checked', 'selected', 'expanded', 'disabled', 'required', 'pressed', 'modal'].includes(p.name) && v && v !== 'false')
          props.push(v === true ? p.name : `${p.name}=${v}`);
        if (p.name === 'url' && v) props.push(`url="${v}"`);
        if (p.name === 'level' && v) props.push(`level=${v}`);
      }
      const uid = n.backendDOMNodeId != null ? `uid=${n.backendDOMNodeId} ` : '';
      const line = `${'  '.repeat(depth)}${uid}${role}${name ? ` "${name.slice(0, 300)}"` : ''}${props.length ? ' ' + props.join(' ') : ''}`;
      chars += line.length + 1;
      if (chars > MAX_SNAPSHOT_CHARS) {
        truncated = true;
        return;
      }
      lines.push(line);
      childDepth = depth + 1;
    }
    for (const cid of n.childIds || []) {
      const c = byId.get(cid);
      if (c) visit(c, childDepth);
    }
  };
  for (const r of roots) visit(r, 0);
  if (truncated) lines.push('… snapshot truncated; use evaluate or a narrower page view for the rest.');
  return lines.join('\n');
}

async function nodeObject(tabId, uid) {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: Number(uid) });
  if (!object?.objectId) throw new Error(`Element uid=${uid} not found; take a new snapshot.`);
  return object.objectId;
}

async function nodeCenter(tabId, uid) {
  await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: Number(uid) }).catch(() => {});
  let quads;
  try {
    ({ quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId: Number(uid) }));
  } catch {
    quads = null;
  }
  if (!quads || !quads.length) {
    const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: Number(uid) });
    quads = [model.border];
  }
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function mouseClick(tabId, x, y, clickCount = 1) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
  }
}

const KEYS = {
  Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Backspace: [8, ''], Delete: [46, ''], Space: [32, ' '],
  ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''],
  Home: [36, ''], End: [35, ''], PageUp: [33, ''], PageDown: [34, ''], Insert: [45, ''],
  F1: [112, ''], F2: [113, ''], F3: [114, ''], F4: [115, ''], F5: [116, ''], F6: [117, ''],
  F7: [118, ''], F8: [119, ''], F9: [120, ''], F10: [121, ''], F11: [122, ''], F12: [123, ''],
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

async function pressKey(tabId, combo) {
  const parts = combo.split('+').filter(Boolean);
  const keyName = parts.pop() || '+';
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODS)) throw new Error(`Unknown modifier ${m}`);
    modifiers |= MODS[m];
  }
  let code;
  let text;
  let key = keyName;
  if (KEYS[keyName]) [code, text] = KEYS[keyName];
  else if (keyName.length === 1) {
    const up = keyName.toUpperCase();
    code = /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : 0;
    text = keyName;
  } else throw new Error(`Unknown key ${keyName}`);
  if (modifiers & (MODS.Control | MODS.Alt | MODS.Meta)) text = '';
  const base = { modifiers, key, windowsVirtualKeyCode: code, code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text: text || undefined });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function fillElement(tabId, uid, value) {
  const objectId = await nodeObject(tabId, uid);
  const r = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    arguments: [{ value: String(value) }],
    functionDeclaration: `function (v) {
      const el = this;
      el.scrollIntoView({ block: 'center' });
      if (el instanceof HTMLSelectElement) {
        const opt = Array.from(el.options).find(o => o.value === v || o.text.trim() === v);
        if (!opt) return { error: 'No option ' + v + '; options: ' + Array.from(el.options).map(o => o.text.trim()).join(' | ') };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = v === 'true';
        if (el.checked !== want) el.click();
        return { ok: true };
      }
      el.focus();
      if (el.isContentEditable) {
        document.getSelection().selectAllChildren(el);
        return { insert: true };
      }
      if ('select' in el) el.select();
      return { insert: true };
    }`,
  });
  const v = r.result?.value || {};
  if (v.error) throw new Error(v.error);
  if (v.insert) {
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', windowsVirtualKeyCode: 46 });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', windowsVirtualKeyCode: 46 });
    if (String(value)) await cdp(tabId, 'Input.insertText', { text: String(value) });
  }
}

async function waitForLoad(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await evaluate(tabId, 'document.readyState');
      if (st.value === 'complete') return true;
    } catch {
      /* context being replaced */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function screenshot(tabId, { fullPage = false, format = 'webp', quality = 80, uid } = {}) {
  const params = { format, captureBeyondViewport: fullPage };
  if (format !== 'png') params.quality = quality;
  if (uid != null) {
    await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: Number(uid) }).catch(() => {});
    const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId: Number(uid) });
    const xs = model.border.filter((_, i) => i % 2 === 0);
    const ys = model.border.filter((_, i) => i % 2 === 1);
    const lm = await cdp(tabId, 'Page.getLayoutMetrics');
    const vp = lm.cssVisualViewport || lm.visualViewport;
    params.clip = {
      x: Math.min(...xs) + vp.pageX,
      y: Math.min(...ys) + vp.pageY,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      scale: 1,
    };
    params.captureBeyondViewport = true;
  } else if (fullPage) {
    const lm = await cdp(tabId, 'Page.getLayoutMetrics');
    const cs = lm.cssContentSize || lm.contentSize;
    params.clip = { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 16000), scale: 1 };
  }
  try {
    const { data } = await cdp(tabId, 'Page.captureScreenshot', params, 20000);
    return { data, mimeType: `image/${format}` };
  } catch (e) {
    throw new Error(`${e.message} Background tabs may not render; call activate_tab first.`);
  }
}

// ---------------------------------------------------------------- tools
const tabIdProp = { tabId: { type: 'number', description: 'Chrome tab id from list_tabs. Defaults to the selected tab.' } };
const tools = [
  { name: 'list_tabs', description: "List all open tabs in the user's own Chrome (id, title, url, active, attached).", inputSchema: { type: 'object', properties: {} } },
  { name: 'select_tab', description: 'Attach the debugger to a tab and make it the default for later calls. Console and network capture start at attach time.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, activate: { type: 'boolean', description: 'Also bring the tab to the front.' } }, required: ['tabId'] } },
  { name: 'new_tab', description: 'Open a new tab in the user Chrome and select it.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, background: { type: 'boolean' } }, required: ['url'] } },
  { name: 'activate_tab', description: 'Bring a tab to the front (needed for screenshots of background tabs).', inputSchema: { type: 'object', properties: tabIdProp } },
  { name: 'close_tab', description: 'Close a tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'detach_tab', description: 'Detach the debugger from a tab (removes Chrome\'s "is debugging this browser" bar when no tab stays attached).', inputSchema: { type: 'object', properties: tabIdProp } },
  { name: 'navigate', description: 'Navigate the tab to a URL, or go back/forward/reload, then wait for load.', inputSchema: { type: 'object', properties: { ...tabIdProp, url: { type: 'string' }, type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'] }, ignoreCache: { type: 'boolean' } } } },
  { name: 'take_snapshot', description: 'Accessibility-tree text snapshot of the page. Each element has a uid usable by click/fill/hover/screenshot.', inputSchema: { type: 'object', properties: { ...tabIdProp, verbose: { type: 'boolean' } } } },
  { name: 'take_screenshot', description: 'Screenshot of the viewport, the full page, or one element (uid).', inputSchema: { type: 'object', properties: { ...tabIdProp, fullPage: { type: 'boolean' }, uid: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpeg', 'webp'] }, quality: { type: 'number' }, filePath: { type: 'string', description: 'Save to this path instead of returning the image.' } } } },
  { name: 'click', description: 'Click an element by uid (real mouse events at its center).', inputSchema: { type: 'object', properties: { ...tabIdProp, uid: { type: 'string' }, dblClick: { type: 'boolean' } }, required: ['uid'] } },
  { name: 'click_at', description: 'Click at viewport CSS-pixel coordinates.', inputSchema: { type: 'object', properties: { ...tabIdProp, x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'hover', description: 'Move the mouse over an element by uid.', inputSchema: { type: 'object', properties: { ...tabIdProp, uid: { type: 'string' } }, required: ['uid'] } },
  { name: 'fill', description: 'Set an input/textarea/contenteditable value, choose a <select> option, or set a checkbox ("true"/"false").', inputSchema: { type: 'object', properties: { ...tabIdProp, uid: { type: 'string' }, value: { type: 'string' } }, required: ['uid', 'value'] } },
  { name: 'type_text', description: 'Type text into the focused element; optionally press a key afterwards.', inputSchema: { type: 'object', properties: { ...tabIdProp, text: { type: 'string' }, submitKey: { type: 'string' } }, required: ['text'] } },
  { name: 'press_key', description: 'Press a key or combination, e.g. "Enter", "Control+A", "Shift+Tab".', inputSchema: { type: 'object', properties: { ...tabIdProp, key: { type: 'string' } }, required: ['key'] } },
  { name: 'scroll', description: 'Scroll the page (or the element under uid) by dx/dy CSS pixels.', inputSchema: { type: 'object', properties: { ...tabIdProp, uid: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' } } } },
  { name: 'evaluate_script', description: 'Evaluate JavaScript in the page. Pass an expression, or a function such as "() => document.title" (async allowed). Returns JSON.', inputSchema: { type: 'object', properties: { ...tabIdProp, function: { type: 'string' } }, required: ['function'] } },
  { name: 'wait_for', description: 'Wait until any of the texts appears in the page body.', inputSchema: { type: 'object', properties: { ...tabIdProp, text: { type: 'array', items: { type: 'string' } }, timeout: { type: 'number' } }, required: ['text'] } },
  { name: 'list_console_messages', description: 'Console messages, exceptions and browser log entries captured since the tab was attached.', inputSchema: { type: 'object', properties: { ...tabIdProp, types: { type: 'array', items: { type: 'string' }, description: 'Filter levels, e.g. ["error","warning","exception"].' }, limit: { type: 'number' }, sinceId: { type: 'number' } } } },
  { name: 'list_network_requests', description: 'Network requests captured since the tab was attached.', inputSchema: { type: 'object', properties: { ...tabIdProp, filter: { type: 'string', description: 'Substring of URL.' }, resourceTypes: { type: 'array', items: { type: 'string' } }, failedOnly: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'get_network_request', description: 'Full headers, post data and response body of one request (reqid from list_network_requests).', inputSchema: { type: 'object', properties: { ...tabIdProp, reqid: { type: 'number' }, maxBodyChars: { type: 'number' } }, required: ['reqid'] } },
  { name: 'cdp_send', description: 'Send a raw Chrome DevTools Protocol command to the tab (e.g. "Emulation.setDeviceMetricsOverride", "Performance.getMetrics", "CSS.getMatchedStylesForNode").', inputSchema: { type: 'object', properties: { ...tabIdProp, method: { type: 'string' }, params: { type: 'object' } }, required: ['method'] } },
];

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fmtTab = (t) => `${t.id}${t.id === currentTab ? '*' : ''}: ${t.active ? '[active] ' : ''}${t.attached ? '[attached] ' : ''}${t.title} — ${t.url}`;

async function afterAction(tabId) {
  await new Promise((r) => setTimeout(r, 300));
  const t = await call('getTab', { tabId }).catch(() => null);
  return t ? `\nTab ${tabId}: ${t.title} — ${t.url}` : '';
}

const handlers = {
  async list_tabs() {
    const tabs = await call('listTabs');
    return text(`## Tabs (* = selected)\n${tabs.map(fmtTab).join('\n')}`);
  },
  async select_tab({ tabId, activate }) {
    await ensureAttached(tabId);
    currentTab = tabId;
    if (activate) await call('activateTab', { tabId });
    const t = await call('getTab', { tabId });
    return text(`Selected ${fmtTab(t)}`);
  },
  async new_tab({ url, background }) {
    const t = await call('createTab', { url, active: !background });
    await ensureAttached(t.id);
    currentTab = t.id;
    await waitForLoad(t.id);
    const nt = await call('getTab', { tabId: t.id });
    return text(`Opened ${fmtTab(nt)}`);
  },
  async activate_tab({ tabId }) {
    const id = tabId ?? currentTab;
    if (id == null) throw new Error('No tab given.');
    const t = await call('activateTab', { tabId: id });
    return text(`Activated ${fmtTab(t)}`);
  },
  async close_tab({ tabId }) {
    await call('closeTab', { tabId });
    if (currentTab === tabId) currentTab = null;
    return text(`Closed tab ${tabId}`);
  },
  async detach_tab({ tabId }) {
    const id = tabId ?? currentTab;
    await call('detach', { tabId: id });
    const s = tabState.get(id);
    if (s) s.enabled = false;
    if (currentTab === id) currentTab = null;
    return text(`Detached tab ${id}`);
  },
  async navigate({ tabId, url, type, ignoreCache }) {
    const id = await resolveTab(tabId);
    const kind = type || (url ? 'url' : 'reload');
    if (kind === 'url') {
      const r = await cdp(id, 'Page.navigate', { url });
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
    } else if (kind === 'reload') await cdp(id, 'Page.reload', { ignoreCache: !!ignoreCache });
    else await call(kind === 'back' ? 'goBack' : 'goForward', { tabId: id });
    await new Promise((r) => setTimeout(r, 200));
    const loaded = await waitForLoad(id);
    const t = await call('getTab', { tabId: id });
    return text(`${loaded ? 'Loaded' : 'Still loading'}: ${t.title} — ${t.url}`);
  },
  async take_snapshot({ tabId, verbose }) {
    const id = await resolveTab(tabId);
    const t = await call('getTab', { tabId: id });
    return text(`## Snapshot of tab ${id}: ${t.title} — ${t.url}\n${await snapshot(id, { verbose })}`);
  },
  async take_screenshot({ tabId, fullPage, uid, format = 'webp', quality, filePath }) {
    const id = await resolveTab(tabId);
    const { data, mimeType } = await screenshot(id, { fullPage, uid, format, quality });
    if (filePath) {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      return text(`Saved screenshot to ${path.resolve(filePath)}`);
    }
    return { content: [{ type: 'image', data, mimeType }] };
  },
  async click({ tabId, uid, dblClick }) {
    const id = await resolveTab(tabId);
    const { x, y } = await nodeCenter(id, uid);
    await mouseClick(id, x, y, dblClick ? 2 : 1);
    return text(`Clicked uid=${uid} at (${Math.round(x)}, ${Math.round(y)})${await afterAction(id)}`);
  },
  async click_at({ tabId, x, y }) {
    const id = await resolveTab(tabId);
    await mouseClick(id, x, y);
    return text(`Clicked at (${x}, ${y})${await afterAction(id)}`);
  },
  async hover({ tabId, uid }) {
    const id = await resolveTab(tabId);
    const { x, y } = await nodeCenter(id, uid);
    await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return text(`Hovered uid=${uid}`);
  },
  async fill({ tabId, uid, value }) {
    const id = await resolveTab(tabId);
    await fillElement(id, uid, value);
    return text(`Filled uid=${uid}`);
  },
  async type_text({ tabId, text: t, submitKey }) {
    const id = await resolveTab(tabId);
    await cdp(id, 'Input.insertText', { text: t });
    if (submitKey) await pressKey(id, submitKey);
    return text(`Typed ${t.length} characters${submitKey ? ` and pressed ${submitKey}` : ''}${await afterAction(id)}`);
  },
  async press_key({ tabId, key }) {
    const id = await resolveTab(tabId);
    await pressKey(id, key);
    return text(`Pressed ${key}${await afterAction(id)}`);
  },
  async scroll({ tabId, uid, dx = 0, dy = 600 }) {
    const id = await resolveTab(tabId);
    let x = 200;
    let y = 200;
    if (uid != null) ({ x, y } = await nodeCenter(id, uid));
    await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
    return text(`Scrolled by (${dx}, ${dy})`);
  },
  async evaluate_script({ tabId, function: src }) {
    const id = await resolveTab(tabId);
    const wrapped = `(async () => { const __v = (${src}\n); return typeof __v === 'function' ? await __v() : await __v; })()`;
    const r = await evaluate(id, wrapped);
    return text(r.value === undefined ? (r.description ?? 'undefined') : r.value);
  },
  async wait_for({ tabId, text: texts, timeout = 15000 }) {
    const id = await resolveTab(tabId);
    const deadline = Date.now() + timeout;
    const expr = `(() => { const b = document.body ? document.body.innerText : ''; return ${JSON.stringify(texts)}.find(t => b.includes(t)) || null; })()`;
    while (Date.now() < deadline) {
      const r = await evaluate(id, expr).catch(() => null);
      if (r && r.value) return text(`Found "${r.value}"`);
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error(`None of ${JSON.stringify(texts)} appeared within ${timeout} ms`);
  },
  async list_console_messages({ tabId, types, limit = 200, sinceId = 0 }) {
    const id = await resolveTab(tabId);
    let msgs = state(id).console.filter((m) => m.id > sinceId);
    if (types && types.length) {
      const want = new Set(types.map((t) => (t === 'warn' ? 'warning' : t)));
      msgs = msgs.filter((m) => want.has(m.level) || (m.level === 'warn' && want.has('warning')));
    }
    msgs = msgs.slice(-limit);
    if (!msgs.length) return text('No console messages captured. Capture starts when the tab is attached; reload the page to catch load-time messages.');
    return text(`## Console (${msgs.length})\n${msgs.map((m) => `msgid=${m.id} [${m.level}] ${m.text}${m.source ? `  (${m.source})` : ''}`).join('\n')}`);
  },
  async list_network_requests({ tabId, filter, resourceTypes, failedOnly, limit = 200 }) {
    const id = await resolveTab(tabId);
    const s = state(id);
    let reqs = s.netOrder.map((k) => s.network.get(k)).filter(Boolean);
    if (filter) reqs = reqs.filter((r) => r.url.includes(filter));
    if (resourceTypes && resourceTypes.length) {
      const want = new Set(resourceTypes.map((t) => t.toLowerCase()));
      reqs = reqs.filter((r) => want.has(String(r.type).toLowerCase()));
    }
    if (failedOnly) reqs = reqs.filter((r) => r.failed || r.status >= 400);
    reqs = reqs.slice(-limit);
    if (!reqs.length) return text('No network requests captured. Capture starts when the tab is attached; reload the page to see load-time requests.');
    return text(`## Network (${reqs.length})\n${reqs.map((r) => `reqid=${r.seq} ${r.method} ${r.url} ${r.failed ? `[FAILED ${r.failed}]` : r.status ? `[${r.status}]` : '[pending]'} ${r.type || ''}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`).join('\n')}`);
  },
  async get_network_request({ tabId, reqid, maxBodyChars = 20000 }) {
    const id = await resolveTab(tabId);
    const s = state(id);
    const r = [...s.network.values()].find((x) => x.seq === reqid);
    if (!r) throw new Error(`Request ${reqid} not found.`);
    let body = null;
    if (r.finished) {
      try {
        const b = await cdp(id, 'Network.getResponseBody', { requestId: r.requestId });
        body = b.base64Encoded ? `<base64, ${b.body.length} chars>` : b.body.slice(0, maxBodyChars) + (b.body.length > maxBodyChars ? `\n… (${b.body.length} chars total)` : '');
      } catch (e) {
        body = `<unavailable: ${e.message}>`;
      }
    }
    const { requestId, started, ...rest } = r;
    return text({ ...rest, responseBody: body });
  },
  async cdp_send({ tabId, method, params }) {
    const id = await resolveTab(tabId);
    return text((await cdp(id, method, params || {}, 60000)) ?? null);
  },
};

// ---------------------------------------------------------------- MCP wiring
const server = new Server(
  { name: 'dsh-chrome-bridge', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions:
      "These tools control the user's own, already-running Chrome (real tabs, logged-in sessions). " +
      'Start with list_tabs, then select_tab or pass tabId. Prefer take_snapshot for structure and uids, take_screenshot for visuals. ' +
      'Do not navigate away from or close tabs the user did not ask you to touch; open new_tab for unrelated browsing.',
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const h = handlers[req.params.name];
  if (!h) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
  try {
    return await h(req.params.arguments || {});
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
  }
});

startWsServer();
await server.connect(new StdioServerTransport());
log(`ready; extension id ${EXTENSION_ID}`);
