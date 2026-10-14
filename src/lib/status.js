// Per-portal connection state → display state, and aggregation of all portals
// into the toolbar badge. Pure, so it can be unit-tested.

export const DEFAULT_STATE = { auth: 'unknown', pull: 'idle', total: 0, error: '', me: null, lastPollAt: 0 };

const COLORS = { ok: '#d6303c', degraded: '#8a8f99', attention: '#e89b0c', off: '#8a8f99' };

// One of: online | polling | login | permission | error | connecting
export function displayState(state) {
  if (state.auth === 'ok') return state.pull === 'online' ? 'online' : 'polling';
  if (state.auth === 'unknown') return 'connecting';
  return state.auth;
}

const host = (origin) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

// entries: [{ origin, ...state }]; t: i18n lookup. Returns { text, color, title }.
export function summarize(entries, { t = (k, s) => (s ? `${k} ${s.join(' ')}` : k), muted = false } = {}) {
  const lines = [];
  let text = '';
  let color = COLORS.ok;
  if (!entries.length) {
    text = '?';
    color = COLORS.off;
    lines.push(t('statusUnconfigured'));
  } else {
    let total = 0;
    let attention = false;
    let degraded = false;
    for (const e of entries) {
      const d = displayState(e);
      if (d === 'login' || d === 'permission' || d === 'error') attention = true;
      if (d !== 'online') degraded = true;
      total += e.auth === 'ok' ? e.total || 0 : 0;
      const status = {
        online: 'statusOnline',
        polling: 'statusPolling',
        connecting: 'statusPolling',
        login: 'statusLogin',
        permission: 'statusUnconfigured',
        error: 'statusError',
      }[d];
      let line = `${host(e.origin)} — ${t(status)}`;
      if (e.auth === 'ok' && e.total > 0) line += ` · ${t('unreadCount', [String(e.total)])}`;
      lines.push(line);
    }
    if (attention) {
      text = '!';
      color = COLORS.attention;
    } else {
      text = total > 99 ? '99+' : total > 0 ? String(total) : '';
      color = degraded ? COLORS.degraded : COLORS.ok;
    }
  }
  if (muted) lines.push(t('statusMuted'));
  return { text, color, title: [t('extName'), ...lines].join('\n') };
}
