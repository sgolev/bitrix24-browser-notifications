// chrome.notifications wrapper. Keeps a registry of what each visible
// notification refers to (in storage.session) so clicks and buttons still work
// after the service worker has been restarted.

import { absoluteUrl } from './format.js';
import { fetchImageDataUrl } from './portal.js';

// Absolute: relative icon paths would resolve against src/ (the worker's location).
const DEFAULT_ICON = chrome.runtime.getURL('icons/icon128.png');
const avatarCache = new Map();

// Notification ids are "<origin>|<local id>", e.g. "https://x.bitrix24.ru|chat:20".
export const notifId = (origin, local) => `${origin}|${local}`;

export function parseNotifId(id) {
  const i = id.indexOf('|');
  return i < 0 ? { origin: '', local: id } : { origin: id.slice(0, i), local: id.slice(i + 1) };
}

export async function iconFor(avatar, origin) {
  const url = absoluteUrl(avatar, origin);
  if (!url) return DEFAULT_ICON;
  if (!avatarCache.has(url)) avatarCache.set(url, (await fetchImageDataUrl(url)) || DEFAULT_ICON);
  return avatarCache.get(url);
}

async function getRegistry() {
  return (await chrome.storage.session.get('notifs')).notifs || {};
}

function setRegistry(notifs) {
  return chrome.storage.session.set({ notifs });
}

// Registry entry for a notification, or one rebuilt from its id if it is still displayed.
export async function lookup(id) {
  const entry = (await getRegistry())[id];
  if (entry) return entry;
  return (await chrome.notifications.getAll())[id] ? entryFromId(id) : null;
}

export async function show(id, entry, options) {
  const opts = { type: 'basic', iconUrl: DEFAULT_ICON, ...options };
  try {
    await chrome.notifications.create(id, opts);
  } catch (e) {
    // A data: icon the platform cannot decode should not cost us the notification.
    if (opts.iconUrl === DEFAULT_ICON) throw e;
    await chrome.notifications.create(id, { ...opts, iconUrl: DEFAULT_ICON });
  }
  const notifs = await getRegistry();
  notifs[id] = { ...entry, shownAt: Date.now() };
  await setRegistry(notifs);
}

export async function clear(id) {
  await chrome.notifications.clear(id);
  await forget(id);
}

export async function forget(id) {
  const notifs = await getRegistry();
  if (!(id in notifs)) return;
  delete notifs[id];
  await setRegistry(notifs);
}

const KINDS = { chat: 'chat', sys: 'system', call: 'call', missed: 'missed', summary: 'summary' };

// Registry entry rebuilt from the id alone, for notifications still on screen that
// the registry no longer knows about (it is wiped when the extension is reloaded).
export function entryFromId(id) {
  const { origin, local } = parseNotifId(id);
  const [prefix, rest] = local.split(/:(.*)/s);
  const kind = KINDS[prefix] || prefix;
  const entry = { origin, kind, shownAt: 0 };
  if (kind === 'chat') Object.assign(entry, { dialogId: rest, lastId: 0 });
  if (kind === 'system') entry.notifyId = Number(rest);
  if (kind === 'call' || kind === 'missed') entry.callId = Number(rest);
  return entry;
}

export async function clearWhere(pred) {
  const notifs = await getRegistry();
  const shown = Object.keys(await chrome.notifications.getAll());
  const candidates = { ...Object.fromEntries(shown.map((id) => [id, entryFromId(id)])), ...notifs };
  const ids = Object.keys(candidates).filter((id) => pred(candidates[id], id));
  await Promise.all(ids.map((id) => chrome.notifications.clear(id)));
  for (const id of ids) delete notifs[id];
  await setRegistry(notifs);
}

// Drops registry entries for notifications that are no longer displayed
// (onClosed is not reported reliably by every platform notification server).
export async function prune() {
  const shown = await chrome.notifications.getAll();
  const notifs = await getRegistry();
  const stale = Object.keys(notifs).filter((id) => !shown[id]);
  if (!stale.length) return;
  for (const id of stale) delete notifs[id];
  await setRegistry(notifs);
}

export async function clearAll() {
  await clearWhere(() => true);
}
