// chrome.notifications wrapper. Keeps a registry of what each visible
// notification refers to (in storage.session) so clicks and buttons still work
// after the service worker has been restarted.

import { absoluteUrl } from './format.js';
import { fetchImageDataUrl } from './portal.js';

// Absolute: relative icon paths would resolve against src/ (the worker's location).
const DEFAULT_ICON = chrome.runtime.getURL('icons/icon128.png');
const avatarCache = new Map();

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

export async function lookup(id) {
  return (await getRegistry())[id] || null;
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

export async function clearWhere(pred) {
  const notifs = await getRegistry();
  const ids = Object.keys(notifs).filter((id) => pred(notifs[id], id));
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
