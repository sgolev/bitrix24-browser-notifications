// Service worker: owns per-portal session state, turns Push&Pull events and
// polling results into desktop notifications, keeps the badge up to date and
// handles clicks. Any number of portals can be configured; notification
// settings are shared.
//
// The WebSockets live in the offscreen document (offscreen/offscreen.js), which
// wakes this worker with a runtime message for every batch of events.

import { getSettings, originPattern, portalForUrl } from './lib/settings.js';
import { callRest, sessidKey, AuthError } from './lib/portal.js';
import { interpret } from './lib/events.js';
import { recentToActions, notificationsToActions, totalUnread } from './lib/poller.js';
import { DEFAULT_STATE, summarize } from './lib/status.js';
import * as notifier from './lib/notifier.js';

const TICK_ALARM = 'tick';
const SAFETY_POLL_MS = 5 * 60 * 1000; // catch-up even while real-time is up
const CATCHUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CATCHUP_MAX_NOTIFICATIONS = 3; // more than this collapses into one summary
const CALL_RING_MAX_MS = 90 * 1000;

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const host = (origin) => new URL(origin).host;
const { notifId } = notifier;

// All state-changing work runs through one queue so storage updates never interleave.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('[b24n]', e)));

// ------------------------------------------------------- per-portal session state
// storage.session "portal:<origin>" = { auth, pull, total, error, me, lastPollAt }

const stateKey = (origin) => `portal:${origin}`;

async function getState(origin) {
  const key = stateKey(origin);
  return { ...DEFAULT_STATE, ...(await chrome.storage.session.get(key))[key] };
}

async function setState(origin, patch) {
  const next = { ...(await getState(origin)), ...patch };
  await chrome.storage.session.set({ [stateKey(origin)]: next });
  await renderBadge();
  return next;
}

async function getAllStates(portals) {
  const stored = await chrome.storage.session.get(portals.map(stateKey));
  return portals.map((origin) => ({ origin, ...DEFAULT_STATE, ...stored[stateKey(origin)] }));
}

async function renderBadge() {
  const s = await getSettings();
  const { text, color, title } = summarize(await getAllStates(s.portals), { t, muted: s.muteUntil > Date.now() });
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title }),
  ]);
}

// --------------------------------------------------------------- notify cursor
// Highest message id seen per dialog and highest bell-notification id, so that
// pull events, catch-up polls and reconnect replays never notify twice.
// storage.local "cursor:<origin>".

const cursorStoreKey = (origin) => `cursor:${origin}`;
const cursorKey = (origin, me) => `${origin}|${me.id}`;

async function loadCursor(origin, me) {
  const key = cursorKey(origin, me);
  const cursor = (await chrome.storage.local.get(cursorStoreKey(origin)))[cursorStoreKey(origin)];
  return cursor && cursor.key === key ? cursor : { key, lastSeen: {}, lastNotifyId: 0, initialized: false };
}

function saveCursor(origin, cursor) {
  return chrome.storage.local.set({ [cursorStoreKey(origin)]: cursor });
}

// ------------------------------------------------------------------ offscreen

let creatingOffscreen = null;

async function hasOffscreen() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keeps the Bitrix24 real-time (Push&Pull) WebSocket connections open.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

// Returns the offscreen info map { [origin]: { state, … } } or null.
async function toOffscreen(cmd, extra = {}) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', cmd, ...extra });
  } catch {
    return null;
  }
}

async function startPull(origin, fresh = false) {
  try {
    const config = await callRest(origin, 'pull.config.get', fresh ? { CACHE: 'N' } : {});
    await toOffscreen('start', { origin, config });
  } catch (e) {
    await handleError(origin, e);
  }
}

// Closes the portal's socket; closes the offscreen document once no socket is left.
async function stopPull(origin) {
  if (!(await hasOffscreen())) return;
  const info = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop', origin }).catch(() => null);
  if (!info || !Object.keys(info).length) await chrome.offscreen.closeDocument().catch(() => {});
}

// --------------------------------------------------------------- lifecycle

async function handleError(origin, e) {
  if (e instanceof AuthError) {
    await stopPull(origin);
    await chrome.storage.session.remove(sessidKey(origin));
    await setState(origin, { auth: 'login', pull: 'idle', total: 0, error: '', me: null });
  } else {
    console.warn('[b24n]', origin, e);
    await setState(origin, { auth: 'error', error: String(e.message || e) });
  }
}

// (Re)establishes one portal: permission, login, baseline cursor, real-time connection.
async function init(origin, reason) {
  if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) {
    await stopPull(origin);
    await setState(origin, { ...DEFAULT_STATE, auth: 'permission' });
    return;
  }
  try {
    const user = await callRest(origin, 'im.user.get');
    const me = { id: Number(user.id), name: user.name, avatar: user.avatar };
    await setState(origin, { auth: 'ok', error: '', me });
    await ensureBaseline(origin, me);
    const info = await toOffscreen('info');
    const pull = info?.[origin];
    if (!pull || pull.state === 'idle' || reason === 'added') await startPull(origin);
    await refreshCounters(origin);
  } catch (e) {
    await handleError(origin, e);
  }
}

async function initAll(reason) {
  const { portals } = await getSettings();
  if (portals.length) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(TICK_ALARM);
  for (const origin of portals) await init(origin, reason);
  if (!portals.length && (await hasOffscreen())) await chrome.offscreen.closeDocument().catch(() => {});
  await renderBadge();
}

// Drops everything kept for a portal that was removed from the settings.
async function forgetPortal(origin) {
  await stopPull(origin);
  await notifier.clearWhere((e) => e.origin === origin);
  await chrome.storage.session.remove([stateKey(origin), sessidKey(origin)]);
  await chrome.storage.local.remove(cursorStoreKey(origin));
}

// Version 1.0 kept single-portal keys; move the cursor, drop the rest.
async function migrateStorage() {
  const { cursor } = await chrome.storage.local.get('cursor');
  if (cursor?.key) {
    const origin = cursor.key.slice(0, cursor.key.lastIndexOf('|'));
    await chrome.storage.local.set({ [cursorStoreKey(origin)]: cursor });
  }
  await chrome.storage.local.remove('cursor');
  await chrome.storage.session.remove(['status', 'me', 'sessid', 'lastPollAt']);
}

// On first run for a portal/user, remember what already exists without notifying.
async function ensureBaseline(origin, me) {
  const cursor = await loadCursor(origin, me);
  if (cursor.initialized) return;
  const [recent, notify] = await Promise.all([
    callRest(origin, 'im.recent.list', { LIMIT: 50 }),
    callRest(origin, 'im.notify.get', { LIMIT: 50 }),
  ]);
  for (const item of recent?.items || []) {
    if (item.message?.id) cursor.lastSeen[String(item.id)] = Number(item.message.id);
  }
  for (const n of notify?.notifications || []) cursor.lastNotifyId = Math.max(cursor.lastNotifyId, Number(n.id));
  cursor.initialized = true;
  await saveCursor(origin, cursor);
  await setState(origin, { lastPollAt: Date.now() });
}

// Polls REST for anything the real-time channel did not deliver.
async function catchUp(origin) {
  const { auth, me } = await getState(origin);
  if (auth !== 'ok' || !me) return;
  try {
    const [recent, notify] = await Promise.all([
      callRest(origin, 'im.recent.list', { LIMIT: 50 }),
      callRest(origin, 'im.notify.get', { LIMIT: 30 }),
    ]);
    const cursor = await loadCursor(origin, me);
    const now = Date.now();
    const chats = recentToActions(recent?.items, {
      myId: me.id,
      lastSeen: cursor.lastSeen,
      now,
      maxAgeMs: CATCHUP_MAX_AGE_MS,
      fileLabel: t('file'),
    });
    const system = notificationsToActions(notify, {
      lastNotifyId: cursor.lastNotifyId,
      now,
      maxAgeMs: CATCHUP_MAX_AGE_MS,
      systemTitle: t('extName'),
    });
    const actions = [...chats.actions, ...system.actions];
    if (actions.length > CATCHUP_MAX_NOTIFICATIONS) {
      await notifySummary(origin, actions);
    } else {
      await applyActions(origin, actions);
    }
    // Advance the cursor past everything inspected (applyActions may have saved it meanwhile).
    const updated = await loadCursor(origin, me);
    for (const [d, id] of Object.entries(chats.seen)) updated.lastSeen[d] = Math.max(updated.lastSeen[d] || 0, id);
    updated.lastNotifyId = Math.max(updated.lastNotifyId, system.maxId);
    await saveCursor(origin, updated);
    await setState(origin, { lastPollAt: now });
    await refreshCounters(origin);
  } catch (e) {
    await handleError(origin, e);
  }
}

// Shown under the notification text when several portals are configured.
async function portalLabel(origin) {
  const { portals } = await getSettings();
  return portals.length > 1 ? { contextMessage: host(origin) } : {};
}

async function notifySummary(origin, actions) {
  const s = await getSettings();
  if (s.muteUntil > Date.now()) return;
  const chats = actions.filter((a) => a.kind === 'chat' && (a.group ? s.notifyGroup : s.notifyPrivate));
  const system = s.notifySystem ? actions.filter((a) => a.kind === 'system') : [];
  if (!chats.length && !system.length) return;
  const lines = [];
  if (chats.length) lines.push(t('summaryChats', [String(chats.length)]) + ': ' + [...new Set(chats.map((a) => a.title))].join(', '));
  if (system.length) lines.push(t('summaryNotifications', [String(system.length)]));
  await notifier.show(notifId(origin, 'summary'), { kind: 'summary', origin }, {
    title: t('summaryTitle'),
    message: lines.join('\n'),
    silent: s.silent,
    ...(await portalLabel(origin)),
  });
}

const countersTimers = new Map();
function scheduleCounters(origin) {
  clearTimeout(countersTimers.get(origin));
  countersTimers.set(origin, setTimeout(() => enqueue(() => refreshCounters(origin)), 1000));
}

async function refreshCounters(origin) {
  const { auth } = await getState(origin);
  if (auth !== 'ok') return;
  try {
    const counters = await callRest(origin, 'im.counters.get');
    await setState(origin, { total: totalUnread(counters) });
  } catch (e) {
    await handleError(origin, e);
  }
}

// ------------------------------------------------------------------ actions

async function portalFocused(origin) {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (!win?.focused) return false;
    const tab = win.tabs?.find((x) => x.active);
    return !!tab?.url?.startsWith(origin + '/');
  } catch {
    return false;
  }
}

async function applyActions(origin, actions) {
  if (!actions.length) return;
  const { me } = await getState(origin);
  if (!me) return;
  const s = await getSettings();
  const cursor = await loadCursor(origin, me);
  const label = await portalLabel(origin);
  let dirty = false;
  const muted = s.muteUntil > Date.now();
  let focused = null;
  const quiet = async () => muted || (s.suppressWhenFocused && (focused ??= await portalFocused(origin)));
  const mine = (kind) => (e) => e.origin === origin && e.kind === kind;

  for (const a of actions) {
    switch (a.kind) {
      case 'chat': {
        if ((cursor.lastSeen[a.dialogId] || 0) >= a.messageId) break;
        cursor.lastSeen[a.dialogId] = a.messageId;
        dirty = true;
        if (!(a.group ? s.notifyGroup : s.notifyPrivate) || (await quiet())) break;
        const id = notifId(origin, `chat:${a.dialogId}`);
        const prev = await notifier.lookup(id);
        const count = a.count || (prev?.count || 0) + 1;
        await notifier.show(id, { kind: 'chat', origin, dialogId: a.dialogId, lastId: a.messageId, count }, {
          title: count > 1 ? `${a.title} (${count})` : a.title,
          message: s.showText ? a.body : t('newMessage'),
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('markRead') }],
          silent: s.silent,
          priority: 1,
          ...label,
        });
        break;
      }
      case 'seen':
      case 'dismiss-chat': {
        const lastId = a.kind === 'seen' ? a.messageId : a.lastId;
        if (Number.isFinite(lastId) && lastId > (cursor.lastSeen[a.dialogId] || 0)) {
          cursor.lastSeen[a.dialogId] = lastId;
          dirty = true;
        }
        if (a.kind === 'seen') break;
        const id = notifId(origin, `chat:${a.dialogId}`);
        const prev = await notifier.lookup(id);
        if (prev && a.lastId >= prev.lastId) await notifier.clear(id);
        break;
      }
      case 'dismiss-chats':
        await notifier.clearWhere(mine('chat'));
        break;
      case 'system': {
        if (a.notifyId <= cursor.lastNotifyId) break;
        cursor.lastNotifyId = a.notifyId;
        dirty = true;
        if (!s.notifySystem || (await quiet())) break;
        await notifier.show(notifId(origin, `sys:${a.notifyId}`), { kind: 'system', origin, notifyId: a.notifyId, link: a.link }, {
          title: a.title,
          message: s.showText ? a.body : t('newNotification'),
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('markRead') }],
          silent: s.silent || a.silent,
          ...label,
        });
        break;
      }
      case 'dismiss-system':
        if (a.ids.length) await Promise.all(a.ids.map((id) => notifier.clear(notifId(origin, `sys:${id}`))));
        else await notifier.clearWhere(mine('system'));
        break;
      case 'call':
        if (!s.notifyCalls || (await quiet())) break;
        await notifier.show(notifId(origin, `call:${a.callId}`), { kind: 'call', origin, callId: a.callId, dialogId: a.dialogId }, {
          title: a.title,
          message: a.name,
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('answer') }],
          requireInteraction: true,
          priority: 2,
          silent: s.silent,
          ...label,
        });
        break;
      case 'dismiss-call':
        await notifier.clear(notifId(origin, `call:${a.callId}`));
        break;
      case 'missed-call':
        if (!s.notifyMissedCalls || muted) break;
        await notifier.show(notifId(origin, `missed:${a.callId}`), { kind: 'missed', origin, dialogId: a.dialogId }, {
          title: a.title,
          message: a.name,
          iconUrl: await notifier.iconFor(a.avatar, origin),
          silent: s.silent,
          ...label,
        });
        break;
      case 'counters':
        scheduleCounters(origin);
        break;
      default:
    }
  }
  if (dirty) await saveCursor(origin, cursor);
}

async function onPullEvents(origin, events) {
  const { me } = await getState(origin);
  if (!me) return;
  const actions = events.flatMap((e) => interpret(e, { myId: me.id, t }));
  await applyActions(origin, actions);
}

async function onPullState(origin, state, detail) {
  const prev = await getState(origin);
  await setState(origin, { pull: state });
  // Reconnected after a gap: fetch whatever was missed.
  if (state === 'online' && prev.pull !== 'online') await catchUp(origin);
  if (state === 'disabled') await catchUp(origin);
  if (detail?.code) console.info('[b24n] pull', origin, state, detail);
}

async function tick() {
  const { portals } = await getSettings();
  const states = await getAllStates(portals);
  const info = states.some((st) => st.auth === 'ok') ? await toOffscreen('info') : null;
  for (const st of states) {
    const { origin } = st;
    if (st.auth !== 'ok') {
      await init(origin, 'tick');
      continue;
    }
    const pull = info?.[origin];
    if (!pull || pull.state === 'idle') await startPull(origin);
    else if (pull.state !== st.pull) await setState(origin, { pull: pull.state });
    if (pull?.state !== 'online' || Date.now() - st.lastPollAt > SAFETY_POLL_MS) await catchUp(origin);
  }
  await notifier.clearWhere((e) => e.kind === 'call' && Date.now() - e.shownAt > CALL_RING_MAX_MS);
  await notifier.prune();
}

// ------------------------------------------------------------------ clicks

// Runs in the portal page: switch the already-loaded messenger instead of reloading.
function openInPage(what, dialogId) {
  const api = window.BX?.Messenger?.Public;
  if (!api) return false;
  if (what === 'notifications') api.openNotifications();
  else api.openChat(dialogId);
  return true;
}

async function openTarget(entry) {
  const origin = entry.origin || (await getSettings()).portals[0];
  if (!origin) return;
  if (entry.kind === 'system' && entry.link) {
    const tab = await chrome.tabs.create({ url: entry.link });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  let url = `${origin}/online/`;
  let args = null;
  if (entry.kind === 'system') args = ['notifications', ''];
  else if (entry.dialogId) {
    url += `?IM_DIALOG=${encodeURIComponent(entry.dialogId)}`;
    args = ['chat', entry.dialogId];
  }
  const tabs = await chrome.tabs.query({ url: originPattern(origin) });
  const tab = tabs.find((x) => x.active) || tabs[0];
  if (!tab) {
    const created = await chrome.tabs.create({ url });
    await chrome.windows.update(created.windowId, { focused: true });
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  if (!args) return;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: openInPage, args });
    if (res?.result) return;
  } catch {
    // page not scriptable (e.g. still loading): fall back to navigation
  }
  await chrome.tabs.update(tab.id, { url });
}

async function onClicked(id) {
  const entry = await notifier.lookup(id);
  await notifier.clear(id);
  await openTarget(entry || { kind: 'summary', origin: notifier.parseNotifId(id).origin });
}

async function onButtonClicked(id, index) {
  const entry = await notifier.lookup(id);
  await notifier.clear(id);
  if (!entry?.origin || index !== 0) return;
  const { origin } = entry;
  try {
    if (entry.kind === 'chat') await callRest(origin, 'im.dialog.read', { DIALOG_ID: entry.dialogId });
    else if (entry.kind === 'system') await callRest(origin, 'im.notify.read', { ID: entry.notifyId, ONLY_CURRENT: 'Y' });
    else await openTarget(entry);
  } catch (e) {
    await handleError(origin, e);
  }
  scheduleCounters(origin);
}

// --------------------------------------------------------------- listeners

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // First install: the extension does nothing until a portal is entered, so say so.
  if (reason === 'install') chrome.runtime.openOptionsPage();
  enqueue(async () => {
    if (reason === 'update') await migrateStorage();
    await initAll('installed');
  });
});
chrome.runtime.onStartup.addListener(() => enqueue(() => initAll('startup')));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) enqueue(tick);
});

chrome.notifications.onClicked.addListener((id) => enqueue(() => onClicked(id)));
chrome.notifications.onButtonClicked.addListener((id, index) => enqueue(() => onButtonClicked(id, index)));
chrome.notifications.onClosed.addListener((id) => enqueue(() => notifier.forget(id)));

chrome.permissions.onAdded.addListener(() => enqueue(() => initAll('permission')));
chrome.permissions.onRemoved.addListener(() => enqueue(() => initAll('permission')));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.portals) {
    const before = changes.portals.oldValue || [];
    const after = changes.portals.newValue || [];
    enqueue(async () => {
      for (const origin of before.filter((o) => !after.includes(o))) await forgetPortal(origin);
      for (const origin of after.filter((o) => !before.includes(o))) {
        if ((await getState(origin)).auth !== 'ok') await init(origin, 'added');
      }
      if (after.length) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
      else await chrome.alarms.clear(TICK_ALARM);
      await renderBadge();
    });
  } else if (changes.muteUntil) {
    enqueue(renderBadge);
  }
});

// A portal page finished loading while we were logged out: the user probably just logged in.
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status !== 'complete' || !tab.url) return;
  enqueue(async () => {
    const origin = portalForUrl((await getSettings()).portals, tab.url);
    if (origin && (await getState(origin)).auth !== 'ok') await init(origin, 'portal-tab');
  });
});

async function stateForUi() {
  const settings = await getSettings();
  return { settings, portals: await getAllStates(settings.portals) };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'background') return;
  switch (msg.cmd) {
    case 'pull-events':
    case 'pull-state':
    case 'pull-need-config':
      enqueue(async () => {
        // A socket for a portal that has since been removed: shut it down.
        if (!(await getSettings()).portals.includes(msg.origin)) return stopPull(msg.origin);
        if (msg.cmd === 'pull-events') await onPullEvents(msg.origin, msg.events);
        else if (msg.cmd === 'pull-state') await onPullState(msg.origin, msg.state, msg.detail);
        else await startPull(msg.origin, true);
      });
      return;
    case 'get-state':
      enqueue(async () => reply(await stateForUi()));
      return true;
    case 'refresh':
      enqueue(async () => {
        if (msg.origin) await init(msg.origin, 'refresh');
        else await initAll('refresh');
        reply(await stateForUi());
      });
      return true;
    case 'open-portal':
      enqueue(() => openTarget({ kind: 'portal', origin: msg.origin }));
      return;
    case 'test-notification':
      enqueue(async () => {
        await notifier.show('test', { kind: 'test' }, {
          title: t('testTitle'),
          message: t('testBody'),
          silent: (await getSettings()).silent,
        });
      });
      return;
    default:
  }
});

// Debug handle for the service worker DevTools console (also used by E2E scripts).
globalThis.b24n = {
  init: (origin) => enqueue(() => (origin ? init(origin, 'debug') : initAll('debug'))),
  tick: () => enqueue(tick),
  catchUp: (origin) => enqueue(() => catchUp(origin)),
  click: (id) => enqueue(() => onClicked(id)),
  button: (id, index = 0) => enqueue(() => onButtonClicked(id, index)),
};
