// User settings (chrome.storage.sync).

export const DEFAULTS = {
  portalUrl: '', // origin, e.g. https://example.bitrix24.ru
  notifyPrivate: true,
  notifyGroup: true,
  notifySystem: true,
  notifyCalls: true,
  notifyMissedCalls: true,
  showText: true,
  suppressWhenFocused: true,
  silent: false,
  muteUntil: 0,
};

export async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

export function setSettings(patch) {
  return chrome.storage.sync.set(patch);
}

// Accepts "b24-x.bitrix24.ru", "https://b24-x.bitrix24.ru/online/" etc. Returns the origin or ''.
export function normalizePortalUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.hostname.includes('.') ? u.origin : '';
  } catch {
    return '';
  }
}

export const originPattern = (origin) => `${origin}/*`;
