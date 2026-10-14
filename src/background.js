// Service worker: owns session state, turns Push&Pull events and polling results
// into desktop notifications, keeps the badge up to date and handles clicks.
//
// The WebSocket itself lives in the offscreen document (offscreen/offscreen.js),
// which wakes this worker with a runtime message for every batch of events.

import { getSettings, originPattern } from './lib/settings.js';
import { callRest, AuthError } from './lib/portal.js';
import { interpret } from './lib/events.js';
import { recentToActions, notificationsToActions, totalUnread } from './lib/poller.js';
import * as notifier from './lib/notifier.js';

const TICK_ALARM = 'tick';
const SAFETY_POLL_MS = 5 * 60 * 1000; // catch-up even while real-time is up
const CATCHUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CATCHUP_MAX_NOTIFICATIONS = 3; // more than this collapses into one summary
const CALL_RING_MAX_MS = 90 * 1000;

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// All state-changing work runs through one queue so storage updates never interleave.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.error('[b24n]', e)));

// ---------------------------------------------------------------- session state

const DEFAULT_STATUS = { auth: 'unconfigured', pull: 'idle', total: 0, error: '' };

async function getSession() {
  const { status, me, lastPollAt } = await chrome.storage.session.get(['status', 'me', 'lastPollAt']);
  return { status: { ...DEFAULT_STATUS, ...status }, me: me || null, lastPollAt: lastPollAt || 0 };
}

async function setStatus(patch) {
  const { status } = await getSession();
  const next = { ...status, ...patch };
  await chrome.storage.session.set({ status: next });
  await renderBadge(next);
  return next;
}

async function renderBadge(status) {
  const { muteUntil } = await getSettings();
  let text = '';
  let color = '#d6303c';
  let title = t('extName');
  if (status.auth === 'unconfigured' || status.auth === 'permission') {
    text = '?';
    color = '#8a8f99';
    title += ` — ${t('statusUnconfigured')}`;
  } else if (status.auth === 'login') {
    text = '!';
    color = '#e89b0c';
    title += ` — ${t('statusLogin')}`;
  } else if (status.auth === 'error') {
    text = '!';
    color = '#8a8f99';
    title += ` — ${t('statusError')}`;
  } else {
    text = status.total > 99 ? '99+' : status.total > 0 ? String(status.total) : '';
    if (status.pull !== 'online') color = '#8a8f99';
    title += ` — ${status.pull === 'online' ? t('statusOnline') : t('statusPolling')}`;
    if (status.total > 0) title += ` · ${t('unreadCount', [String(status.total)])}`;
  }
  if (muteUntil > Date.now()) title += ` · ${t('statusMuted')}`;
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title }),
  ]);
}

async function portalOrigin() {
  return (await getSettings()).portalUrl;
}

// --------------------------------------------------------------- notify cursor
// Highest message id seen per dialog and highest bell-notification id, so that
// pull events, catch-up polls and reconnect replays never notify twice.

async function loadCursor(key) {
  const { cursor } = await chrome.storage.local.get('cursor');
  return cursor && cursor.key === key ? cursor : { key, lastSeen: {}, lastNotifyId: 0, initialized: false };
}

function saveCursor(cursor) {
  return chrome.storage.local.set({ cursor });
}

const cursorKey = (origin, me) => `${origin}|${me.id}`;

// ------------------------------------------------------------------ offscreen

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keeps the Bitrix24 real-time (Push&Pull) WebSocket connection open.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

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
    await toOffscreen('start', { config });
  } catch (e) {
    await handleError(e);
  }
}

async function stopPull() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => {});
}

// --------------------------------------------------------------- lifecycle

async function handleError(e) {
  if (e instanceof AuthError) {
    await stopPull();
    await chrome.storage.session.remove(['me', 'sessid']);
    await setStatus({ auth: 'login', pull: 'idle', total: 0, error: '' });
  } else {
    console.warn('[b24n]', e);
    await setStatus({ auth: 'error', error: String(e.message || e) });
  }
}

// (Re)establishes everything: permission, login, baseline cursor, real-time connection.
async function init(reason) {
  const origin = await portalOrigin();
  if (!origin) {
    await stopPull();
    await setStatus({ ...DEFAULT_STATUS });
    return;
  }
  if (!(await chrome.permissions.contains({ origins: [originPattern(origin)] }))) {
    await stopPull();
    await setStatus({ ...DEFAULT_STATUS, auth: 'permission' });
    return;
  }
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  try {
    const user = await callRest(origin, 'im.user.get');
    const me = { id: Number(user.id), name: user.name, avatar: user.avatar, origin };
    await chrome.storage.session.set({ me });
    await setStatus({ auth: 'ok', error: '' });
    await ensureBaseline(origin, me);
    const info = await toOffscreen('info');
    if (!info || info.state === 'idle' || reason === 'settings') await startPull(origin);
    await refreshCounters();
  } catch (e) {
    await handleError(e);
  }
}

// On first run for a portal/user, remember what already exists without notifying.
async function ensureBaseline(origin, me) {
  const cursor = await loadCursor(cursorKey(origin, me));
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
  await saveCursor(cursor);
  await chrome.storage.session.set({ lastPollAt: Date.now() });
}

// Polls REST for anything the real-time channel did not deliver.
async function catchUp() {
  const { status, me } = await getSession();
  if (status.auth !== 'ok' || !me) return;
  const origin = me.origin;
  try {
    const [recent, notify] = await Promise.all([
      callRest(origin, 'im.recent.list', { LIMIT: 50 }),
      callRest(origin, 'im.notify.get', { LIMIT: 30 }),
    ]);
    const cursor = await loadCursor(cursorKey(origin, me));
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
      await notifySummary(actions);
    } else {
      await applyActions(actions);
    }
    // Advance the cursor past everything inspected (applyActions may have saved it meanwhile).
    const updated = await loadCursor(cursorKey(origin, me));
    for (const [d, id] of Object.entries(chats.seen)) updated.lastSeen[d] = Math.max(updated.lastSeen[d] || 0, id);
    updated.lastNotifyId = Math.max(updated.lastNotifyId, system.maxId);
    await saveCursor(updated);
    await chrome.storage.session.set({ lastPollAt: now });
    await refreshCounters();
  } catch (e) {
    await handleError(e);
  }
}

async function notifySummary(actions) {
  const s = await getSettings();
  if (s.muteUntil > Date.now()) return;
  const chats = actions.filter((a) => a.kind === 'chat' && (a.group ? s.notifyGroup : s.notifyPrivate));
  const system = s.notifySystem ? actions.filter((a) => a.kind === 'system') : [];
  if (!chats.length && !system.length) return;
  const lines = [];
  if (chats.length) lines.push(t('summaryChats', [String(chats.length)]) + ': ' + [...new Set(chats.map((a) => a.title))].join(', '));
  if (system.length) lines.push(t('summaryNotifications', [String(system.length)]));
  await notifier.show('summary', { kind: 'summary' }, {
    title: t('summaryTitle'),
    message: lines.join('\n'),
    silent: s.silent,
  });
}

let countersTimer = null;
function scheduleCounters() {
  clearTimeout(countersTimer);
  countersTimer = setTimeout(() => enqueue(refreshCounters), 1000);
}

async function refreshCounters() {
  const { status, me } = await getSession();
  if (status.auth !== 'ok' || !me) return;
  try {
    const counters = await callRest(me.origin, 'im.counters.get');
    await setStatus({ total: totalUnread(counters) });
  } catch (e) {
    await handleError(e);
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

async function applyActions(actions) {
  if (!actions.length) return;
  const { me } = await getSession();
  if (!me) return;
  const origin = me.origin;
  const s = await getSettings();
  const cursor = await loadCursor(cursorKey(origin, me));
  let dirty = false;
  const muted = s.muteUntil > Date.now();
  let focused = null;
  const quiet = async () => muted || (s.suppressWhenFocused && (focused ??= await portalFocused(origin)));

  for (const a of actions) {
    switch (a.kind) {
      case 'chat': {
        if ((cursor.lastSeen[a.dialogId] || 0) >= a.messageId) break;
        cursor.lastSeen[a.dialogId] = a.messageId;
        dirty = true;
        if (!(a.group ? s.notifyGroup : s.notifyPrivate) || (await quiet())) break;
        const id = `chat:${a.dialogId}`;
        const prev = await notifier.lookup(id);
        const count = a.count || (prev ? prev.count + 1 : 1);
        await notifier.show(id, { kind: 'chat', dialogId: a.dialogId, lastId: a.messageId, count }, {
          title: count > 1 ? `${a.title} (${count})` : a.title,
          message: s.showText ? a.body : t('newMessage'),
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('markRead') }],
          silent: s.silent,
          priority: 1,
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
        const id = `chat:${a.dialogId}`;
        const prev = await notifier.lookup(id);
        if (prev && a.lastId >= prev.lastId) await notifier.clear(id);
        break;
      }
      case 'dismiss-chats':
        await notifier.clearWhere((e) => e.kind === 'chat');
        break;
      case 'system': {
        if (a.notifyId <= cursor.lastNotifyId) break;
        cursor.lastNotifyId = a.notifyId;
        dirty = true;
        if (!s.notifySystem || (await quiet())) break;
        await notifier.show(`sys:${a.notifyId}`, { kind: 'system', notifyId: a.notifyId, link: a.link }, {
          title: a.title,
          message: s.showText ? a.body : t('newNotification'),
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('markRead') }],
          silent: s.silent || a.silent,
        });
        break;
      }
      case 'dismiss-system':
        if (a.ids.length) await Promise.all(a.ids.map((id) => notifier.clear(`sys:${id}`)));
        else await notifier.clearWhere((e) => e.kind === 'system');
        break;
      case 'call':
        if (!s.notifyCalls || (await quiet())) break;
        await notifier.show(`call:${a.callId}`, { kind: 'call', callId: a.callId, dialogId: a.dialogId }, {
          title: a.title,
          message: a.name,
          iconUrl: await notifier.iconFor(a.avatar, origin),
          buttons: [{ title: t('answer') }],
          requireInteraction: true,
          priority: 2,
          silent: s.silent,
        });
        break;
      case 'dismiss-call':
        await notifier.clear(`call:${a.callId}`);
        break;
      case 'missed-call':
        if (!s.notifyMissedCalls || muted) break;
        await notifier.show(`missed:${a.callId}`, { kind: 'missed', dialogId: a.dialogId }, {
          title: a.title,
          message: a.name,
          iconUrl: await notifier.iconFor(a.avatar, origin),
          silent: s.silent,
        });
        break;
      case 'counters':
        scheduleCounters();
        break;
      default:
    }
  }
  if (dirty) await saveCursor(cursor);
}

async function onPullEvents(events) {
  const { me } = await getSession();
  if (!me) return;
  const actions = events.flatMap((e) => interpret(e, { myId: me.id, t }));
  await applyActions(actions);
}

async function onPullState(state, detail) {
  const { status } = await getSession();
  await setStatus({ pull: state });
  // Reconnected after a gap: fetch whatever was missed.
  if (state === 'online' && status.pull !== 'online') await catchUp();
  if (state === 'disabled') await catchUp();
  if (detail?.code) console.info('[b24n] pull', state, detail);
}

async function tick() {
  const { status, lastPollAt } = await getSession();
  if (status.auth !== 'ok') return init('tick');
  const origin = await portalOrigin();
  const info = await toOffscreen('info');
  if (!info || info.state === 'idle') await startPull(origin);
  else if (info.state !== status.pull) await setStatus({ pull: info.state });
  if ((info?.state !== 'online') || Date.now() - lastPollAt > SAFETY_POLL_MS) await catchUp();
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
  const origin = await portalOrigin();
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
  if (entry) await openTarget(entry);
  else await openTarget({ kind: 'summary' });
}

async function onButtonClicked(id, index) {
  const entry = await notifier.lookup(id);
  await notifier.clear(id);
  if (!entry || index !== 0) return;
  const origin = await portalOrigin();
  try {
    if (entry.kind === 'chat') await callRest(origin, 'im.dialog.read', { DIALOG_ID: entry.dialogId });
    else if (entry.kind === 'system') await callRest(origin, 'im.notify.read', { ID: entry.notifyId, ONLY_CURRENT: 'Y' });
    else await openTarget(entry);
  } catch (e) {
    await handleError(e);
  }
  scheduleCounters();
}

// --------------------------------------------------------------- listeners

chrome.runtime.onInstalled.addListener(() => enqueue(() => init('installed')));
chrome.runtime.onStartup.addListener(() => enqueue(() => init('startup')));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) enqueue(tick);
});

chrome.notifications.onClicked.addListener((id) => enqueue(() => onClicked(id)));
chrome.notifications.onButtonClicked.addListener((id, index) => enqueue(() => onButtonClicked(id, index)));
chrome.notifications.onClosed.addListener((id) => enqueue(() => notifier.forget(id)));

chrome.permissions.onAdded.addListener(() => enqueue(() => init('permission')));
chrome.permissions.onRemoved.addListener(() => enqueue(() => init('permission')));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.portalUrl) {
    enqueue(async () => {
      await stopPull();
      await notifier.clearAll();
      await chrome.storage.session.remove(['me', 'sessid', 'status', 'lastPollAt']);
      await init('settings');
    });
  } else if (changes.muteUntil) {
    enqueue(async () => renderBadge((await getSession()).status));
  }
});

// A portal page finished loading while we were logged out: the user probably just logged in.
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status !== 'complete' || !tab.url) return;
  enqueue(async () => {
    const origin = await portalOrigin();
    if (!origin || !tab.url.startsWith(origin + '/')) return;
    const { status } = await getSession();
    if (status.auth !== 'ok') await init('portal-tab');
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'background') return;
  switch (msg.cmd) {
    case 'pull-events':
      enqueue(() => onPullEvents(msg.events));
      return;
    case 'pull-state':
      enqueue(() => onPullState(msg.state, msg.detail));
      return;
    case 'pull-need-config':
      enqueue(async () => {
        const origin = await portalOrigin();
        if (origin) await startPull(origin, true);
      });
      return;
    case 'get-state':
      enqueue(async () => reply({ ...(await getSession()), settings: await getSettings() }));
      return true;
    case 'refresh':
      enqueue(async () => {
        await init('refresh');
        reply({ ...(await getSession()), settings: await getSettings() });
      });
      return true;
    case 'open-portal':
      enqueue(() => openTarget({ kind: 'portal' }));
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
  init: () => enqueue(() => init('debug')),
  tick: () => enqueue(tick),
  catchUp: () => enqueue(catchUp),
  click: (id) => enqueue(() => onClicked(id)),
  button: (id, index = 0) => enqueue(() => onButtonClicked(id, index)),
};
