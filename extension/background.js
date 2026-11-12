// DSH Browser Bridge: connects this Chrome to the local DSH MCP bridge and
// runs Chrome DevTools Protocol commands on user tabs through chrome.debugger.
const BRIDGE_URL = 'ws://127.0.0.1:17321/ext';
const PROTOCOL_VERSION = '1.3';

let ws = null;
let retryTimer = null;
const attached = new Set();

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#247bbf' }).catch(() => {});
  chrome.action
    .setTitle({ title: connected ? 'DSH Browser Bridge: connected' : 'DSH Browser Bridge: waiting for DSH' })
    .catch(() => {});
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, 3000);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    setBadge(true);
    send({ type: 'hello', version: chrome.runtime.getManifest().version, attached: Array.from(attached) });
  };
  ws.onclose = () => {
    ws = null;
    setBadge(false);
    scheduleRetry();
  };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (msg.id == null) return;
    try {
      const result = await dispatch(msg.op, msg.args || {});
      send({ id: msg.id, result: result === undefined ? null : result });
    } catch (e) {
      send({ id: msg.id, error: String((e && e.message) || e) });
    }
  };
}

function tabInfo(t) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: t.active,
    title: t.title || '',
    url: t.url || t.pendingUrl || '',
    status: t.status,
    attached: attached.has(t.id),
  };
}

async function allTabs() {
  const windows = await chrome.windows.getAll({ populate: true });
  const out = [];
  for (const w of windows) for (const t of w.tabs || []) out.push(tabInfo(t));
  return out;
}

async function attach(tabId) {
  if (attached.has(tabId)) return { alreadyAttached: true };
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!/already attached/i.test(m)) throw e;
  }
  attached.add(tabId);
  return { alreadyAttached: false };
}

const ops = {
  listTabs: () => allTabs(),
  getTab: async (a) => tabInfo(await chrome.tabs.get(a.tabId)),
  attach: (a) => attach(a.tabId),
  detach: async (a) => {
    if (attached.has(a.tabId)) {
      attached.delete(a.tabId);
      await chrome.debugger.detach({ tabId: a.tabId }).catch(() => {});
    }
    return true;
  },
  cdp: (a) => chrome.debugger.sendCommand({ tabId: a.tabId }, a.method, a.params || {}),
  createTab: async (a) => tabInfo(await chrome.tabs.create({ url: a.url || 'about:blank', active: a.active !== false })),
  activateTab: async (a) => {
    const t = await chrome.tabs.update(a.tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    return tabInfo(t);
  },
  closeTab: async (a) => {
    await chrome.tabs.remove(a.tabId);
    return true;
  },
  goBack: async (a) => {
    await chrome.tabs.goBack(a.tabId);
    return true;
  },
  goForward: async (a) => {
    await chrome.tabs.goForward(a.tabId);
    return true;
  },
};

function dispatch(op, args) {
  const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
  if (!fn) throw new Error('Unknown op: ' + op);
  return fn(args);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  send({ type: 'event', tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  send({ type: 'detached', tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  send({ type: 'tabRemoved', tabId });
});

// MV3 service workers get suspended; the alarm wakes the worker to reconnect.
chrome.alarms.create('dsh-bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.action.onClicked.addListener(() => connect());

setBadge(false);
connect();
