// Where the Push&Pull WebSockets live.
//
// - Chromium: an offscreen document. The MV3 service worker is suspended after
//   ~30 s without extension events, and the pull server sends no keepalive traffic.
// - Firefox: the background event page itself (Firefox has no offscreen documents).
//   Light periodic API activity keeps the page awake while sockets are open; if it
//   is suspended anyway, the background's 1-minute tick reconnects and catches up.
//
// Both hosts deliver the same messages to the handler set with onMessage():
//   { cmd: 'pull-events', origin, events } | { cmd: 'pull-state', origin, state, detail }
//   | { cmd: 'pull-need-config', origin, reason }
// and their start/stop/info/poke calls resolve to the info map { [origin]: client.info() }.

import { PullClient } from './pull.js';

const KEEPALIVE_MS = 20 * 1000;

export function createPullHost() {
  return chrome.offscreen ? createOffscreenHost() : createLocalHost({ keepAlive: true });
}

// One PullClient per portal in the current context.
export function createLocalHost({ keepAlive = false } = {}) {
  let handler = () => {};
  const clients = new Map();
  let keepAliveTimer = null;

  const info = () => Object.fromEntries([...clients].map(([origin, c]) => [origin, c.info()]));

  function updateKeepAlive() {
    if (!keepAlive) return;
    if (clients.size && !keepAliveTimer) {
      keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
    } else if (!clients.size && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function clientFor(origin) {
    if (!clients.has(origin)) {
      clients.set(
        origin,
        new PullClient({
          onEvents: (events) => handler({ cmd: 'pull-events', origin, events }),
          onState: (state, detail) => handler({ cmd: 'pull-state', origin, state, detail }),
          onNeedConfig: (reason) => handler({ cmd: 'pull-need-config', origin, reason }),
        }),
      );
    }
    return clients.get(origin);
  }

  const pokeAll = () => {
    for (const c of clients.values()) c.poke();
  };
  globalThis.addEventListener?.('online', pokeAll);

  return {
    onMessage(fn) {
      handler = fn;
    },
    async start(origin, config) {
      clientFor(origin).start(config);
      updateKeepAlive();
      return info();
    },
    async stop(origin) {
      const client = clients.get(origin);
      clients.delete(origin);
      client?.stop();
      updateKeepAlive();
      return info();
    },
    async info() {
      return info();
    },
    async poke() {
      pokeAll();
      return info();
    },
    async closeAll() {
      const all = [...clients.values()];
      clients.clear();
      for (const c of all) c.stop();
      updateKeepAlive();
    },
  };
}

// Proxy to a local host running in offscreen/offscreen.html.
function createOffscreenHost() {
  let handler = () => {};
  let creating = null;

  const exists = async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;

  async function ensure() {
    if (await exists()) return;
    creating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Keeps the Bitrix24 real-time (Push&Pull) WebSocket connections open.',
      })
      .finally(() => (creating = null));
    await creating;
  }

  async function send(cmd, extra = {}) {
    await ensure();
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', cmd, ...extra });
    } catch {
      return null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'background' && msg.cmd?.startsWith('pull-')) handler(msg);
  });

  return {
    onMessage(fn) {
      handler = fn;
    },
    start: (origin, config) => send('start', { origin, config }),
    info: () => send('info'),
    poke: () => send('poke'),
    // Closes the portal's socket; closes the document once no socket is left.
    async stop(origin) {
      if (!(await exists())) return {};
      const info = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop', origin }).catch(() => null);
      if (!info || !Object.keys(info).length) await chrome.offscreen.closeDocument().catch(() => {});
      return info || {};
    },
    async closeAll() {
      if (await exists()) await chrome.offscreen.closeDocument().catch(() => {});
    },
  };
}
