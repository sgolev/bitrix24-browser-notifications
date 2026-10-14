// Minimal Bitrix24 Push&Pull WebSocket client (text mode). Runs in the offscreen
// document; the service worker supplies the config from pull.config.get.
// See docs/protocol.md.

export const REVISION = 19;

export const State = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  OFFLINE: 'offline',
  DISABLED: 'disabled',
};

export function buildUrl(config, { mid } = {}) {
  const server = config.server || {};
  const base = server.websocket_secure || server.websocket;
  if (!base) return null;
  const q = new URLSearchParams();
  if (config.jwt) {
    q.set('token', config.jwt);
  } else {
    const ids = ['private', 'shared'].map((k) => config.channels?.[k]?.id).filter(Boolean);
    if (!ids.length) return null;
    q.set('CHANNEL_ID', ids.join('/'));
  }
  if (server.mode === 'shared' && config.clientId) q.set('clientId', config.clientId);
  if (server.hostname) q.set('hostname', server.hostname);
  if (mid) q.set('mid', mid);
  q.set('revision', String(REVISION));
  return `${base}?${q}`;
}

// A frame holds one or more "#!NGINXNMS!#{json}#!NGINXNME!#" blocks; newer
// servers may send a bare JSON array instead.
export function parseFrame(data) {
  if (typeof data !== 'string' || !data) return [];
  const out = [];
  if (data.includes('#!NGINXNMS!#')) {
    const re = /#!NGINXNMS!#([\s\S]*?)#!NGINXNME!#/g;
    let m;
    while ((m = re.exec(data))) {
      try {
        out.push(JSON.parse(m[1]));
      } catch {
        // skip malformed block
      }
    }
    return out;
  }
  try {
    const j = JSON.parse(data);
    return Array.isArray(j) ? j : [j];
  } catch {
    return [];
  }
}

// Reconnect delay in seconds for the n-th consecutive failure (docs: 0.5/5/25/45/60 + 0–20%).
export function backoffDelay(attempt, random = Math.random) {
  const base = attempt < 1 ? 0.5 : attempt < 3 ? 5 : attempt < 5 ? 25 : attempt < 10 ? 45 : 60;
  return base + base * random() * 0.2;
}

// Earliest moment (ms) at which the config must be refreshed.
export function configExpiry(config) {
  const times = [];
  for (const ch of Object.values(config.channels || {})) {
    const t = Date.parse(ch?.end);
    if (Number.isFinite(t)) times.push(t);
  }
  if (Number(config.exp) > 0) times.push(Number(config.exp) * 1000);
  return times.length ? Math.min(...times) : null;
}

const CONFIG_REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_FAILURES_BEFORE_NEW_CONFIG = 3;
const SEEN_MIDS = 200;

export class PullClient {
  constructor({
    onEvents,
    onState,
    onNeedConfig,
    WebSocketImpl = globalThis.WebSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    now = () => Date.now(),
    random = Math.random,
  }) {
    Object.assign(this, { onEvents, onState, onNeedConfig, WebSocketImpl, setTimer, clearTimer, now, random });
    this.config = null;
    this.socket = null;
    this.state = State.IDLE;
    this.failures = 0;
    this.mid = null;
    this.seen = [];
    this.reconnectTimer = null;
    this.expiryTimer = null;
    this.lastMessageAt = 0;
    this.connectedAt = 0;
  }

  // Starts (or restarts) with a fresh config. Keeps `mid` so missed messages are replayed.
  start(config) {
    this.config = config;
    this.failures = 0;
    this._scheduleExpiry();
    if (!config?.server?.websocket_enabled || !buildUrl(config)) {
      this._close();
      this._setState(State.DISABLED);
      return;
    }
    this._connect();
  }

  stop() {
    this.config = null;
    this.mid = null;
    this._clearTimers();
    this._close();
    this._setState(State.IDLE);
  }

  // Reconnect immediately if not connected (e.g. after the network comes back).
  poke() {
    if (this.config && this.state !== State.ONLINE && this.state !== State.CONNECTING && this.state !== State.DISABLED) {
      this._connect();
    }
  }

  info() {
    return { state: this.state, failures: this.failures, lastMessageAt: this.lastMessageAt, connectedAt: this.connectedAt };
  }

  _setState(state, detail) {
    if (this.state === state && !detail) return;
    this.state = state;
    this.onState?.(state, detail);
  }

  _clearTimers() {
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.reconnectTimer = this.expiryTimer = null;
  }

  _scheduleExpiry() {
    if (this.expiryTimer) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    const exp = this.config && configExpiry(this.config);
    if (!exp) return;
    const delay = Math.max(exp - CONFIG_REFRESH_MARGIN_MS - this.now(), 1000);
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.onNeedConfig?.('expired');
    }, delay);
  }

  _close(code = 1000, reason = 'client') {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(code, reason);
    } catch {
      // already closed
    }
  }

  _connect() {
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this._close();
    const url = buildUrl(this.config, { mid: this.mid });
    if (!url) return;
    this._setState(State.CONNECTING);
    let socket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (e) {
      this._onClose({ code: 0, reason: String(e) }, false);
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.failures = 0;
      this.connectedAt = this.now();
      this._setState(State.ONLINE);
    };
    socket.onmessage = (e) => this._onMessage(e.data);
    socket.onerror = () => {};
    socket.onclose = (e) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this._onClose(e, opened);
    };
  }

  _onClose(e, wasOpen) {
    if (!this.config) return;
    if (!wasOpen) this.failures++;
    this._setState(State.OFFLINE, { code: e.code, reason: e.reason });
    if (!wasOpen && this.failures >= MAX_FAILURES_BEFORE_NEW_CONFIG && this.failures % MAX_FAILURES_BEFORE_NEW_CONFIG === 0) {
      // Channels may have been invalidated server-side; ask for a fresh config.
      this.onNeedConfig?.('connect-failed');
    }
    this._scheduleReconnect(wasOpen ? 0 : this.failures);
  }

  _scheduleReconnect(attempt, extraSeconds = 0) {
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    const delay = (backoffDelay(attempt, this.random) + extraSeconds) * 1000;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _onMessage(data) {
    this.lastMessageAt = this.now();
    const events = [];
    for (const msg of parseFrame(data)) {
      if (msg.mid) {
        if (this.seen.includes(msg.mid)) continue;
        this.seen.push(msg.mid);
        if (this.seen.length > SEEN_MIDS) this.seen.shift();
        this.mid = msg.mid;
      }
      const text = msg.text;
      if (!text || typeof text !== 'object') continue;
      if (text.module_id === 'pull') {
        this._handleInternal(text);
        continue;
      }
      if (text.module_id === 'online') continue; // presence updates, not needed
      events.push(text);
    }
    if (events.length) this.onEvents?.(events);
  }

  _handleInternal(text) {
    const p = text.params || {};
    switch (String(text.command).toLowerCase()) {
      case 'channel_expire':
        if (p.action === 'reconnect' && p.channel?.type && p.new_channel) {
          this.config.channels[p.channel.type] = p.new_channel;
          this._scheduleExpiry();
          this._connect();
        } else {
          this.onNeedConfig?.('channel-expired');
        }
        break;
      case 'config_expire':
        this.onNeedConfig?.('config-expired');
        break;
      case 'server_restart':
        this._close();
        this._setState(State.OFFLINE, { reason: 'server_restart' });
        this._scheduleReconnect(1, 10 + this.random() * 20);
        break;
      default:
    }
  }
}
