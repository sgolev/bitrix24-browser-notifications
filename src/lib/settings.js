// User settings (chrome.storage.sync). Notification settings are shared by all portals.

export const DEFAULTS = {
  portals: [], // origins, e.g. ["https://example.bitrix24.ru"]
  notifyPrivate: true,
  notifyGroup: true,
  notifySystem: true,
  notifyCalls: true,
  notifyMissedCalls: true,
  notifyReactions: true,
  notifyConnection: true, // being logged out of a portal
  showText: true,
  suppressWhenFocused: true,
  silent: false,
  muteUntil: 0,
};

// Version 1.0 stored a single `portalUrl`; fold it into `portals`.
export function migrate(raw) {
  if (raw.portalUrl === undefined) return { settings: raw, migrated: false };
  const { portalUrl, ...rest } = raw;
  const portals = [...(raw.portals || [])];
  const origin = normalizePortalUrl(portalUrl);
  if (origin && !portals.includes(origin)) portals.push(origin);
  return { settings: { ...rest, portals }, migrated: true };
}

export async function getSettings() {
  const { settings, migrated } = migrate(await chrome.storage.sync.get(null));
  if (migrated) {
    await chrome.storage.sync.set({ portals: settings.portals });
    await chrome.storage.sync.remove('portalUrl');
  }
  return { ...DEFAULTS, ...settings };
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

// Returns { origin, portals, error } where error is '' | 'invalid' | 'duplicate'.
export function addPortal(portals, input) {
  const origin = normalizePortalUrl(input);
  if (!origin) return { origin, portals, error: 'invalid' };
  if (portals.includes(origin)) return { origin, portals, error: 'duplicate' };
  return { origin, portals: [...portals, origin], error: '' };
}

export const originPattern = (origin) => `${origin}/*`;

// The configured portal a URL belongs to, or ''.
export const portalForUrl = (portals, url) => portals.find((o) => url?.startsWith(o + '/')) || '';
