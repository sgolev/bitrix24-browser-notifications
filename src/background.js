// Background (Chromium service worker / Firefox event page): owns per-portal
// session state, turns Push&Pull events and polling results into desktop
// notifications, keeps the badge up to date and handles clicks. Any number of
// portals can be configured; notification settings are shared.
//
// The WebSockets live in a pull host (lib/pull-host.js): an offscreen document on
// Chromium, the background page itself on Firefox.

import { getSettings, originPattern, portalForUrl } from './lib/settings.js';
import { callRest, sessidKey, AuthError, INTERACTIVE_TIMEOUT_MS } from './lib/portal.js';
import { interpret } from './lib/events.js';
import { recentToActions, notificationsToActions, totalUnread } from './lib/poller.js';
import { DEFAULT_STATE, summarize } from './lib/status.js';
import { stateKey, getState, getAllStates } from './lib/state.js';
import * as notifier from './lib/notifier.js';
import { createPullHost } from './lib/pull-host.js';
import { createSerializer } from './lib/serial.js';

const TICK_ALARM = 'tick';
const SAFETY_POLL_MS = 5 * 60 * 1000; // catch-up even while real-time is up
const CATCHUP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CATCHUP_MAX_NOTIFICATIONS = 3; // more than this collapses into one summary
const CALL_RING_MAX_MS = 90 * 1000;

const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const host = (origin) => new URL(origin).host;
const { notifId } = notifier;

// Work is queued per portal: a portal's state, sessid, cursor and socket are only
// touched by its own queue, so one slow or unresponsive portal never delays
// another portal's notifications. What portals share has its own lock: the
// notification registry (lib/notifier.js) and the badge (below).
const serialize = createSerializer();
const enqueueFor = (origin, fn) => serialize(`portal ${origin}`, fn).catch((e) => console.error('[b24n]', origin, e));

// ------------------------------------------------------- per-portal session state
// storage.session "portal:<origin>" (see lib/state.js). Only the background writes it.

async function setState(origin, patch) {
  const next = { ...(await getState(origin)), ...patch };
  await chrome.storage.session.set({ [stateKey(origin)]: next });
  await renderBadge();
  return next;
}

// Serialized, so an older summary never overwrites a newer one.
const renderBadge = () => serialize('badge', drawBadge);

async function drawBadge() {
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

// ----------------------------------------------------------------- pull host

const pullHost = createPullHost();

async function startPull(origin, fresh = false) {
  try {
    const config = await callRest(origin, 'pull.config.get', fresh ? { CACHE: 'N' } : {});
    await pullHost.start(origin, config);
  } catch (e) {
    await handleError(origin, e);
  }
}

async function stopPull(origin) {
  await pullHost.stop(origin);
}

// --------------------------------------------------------------- lifecycle

async function handleError(origin, e) {
  if (e instanceof AuthError) {
    await stopPull(origin);
    await chrome.storage.session.remove(sessidKey(origin));
    await setState(origin, { auth: 'login', pull: 'idle', total: 0, error: '', errorKind: '', me: null });
  } else {
    console.warn('[b24n]', origin, e);
    // A timeout gets its own status ("not responding"); the tick keeps retrying.
    const timeout = e.code === 'TIMEOUT';
    await setState(origin, { auth: 'error', errorKind: timeout ? 'timeout' : 'error', error: timeout ? '' : String(e.message || e) });
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
    await setState(origin, { auth: 'ok', error: '', errorKind: '', me });
    await ensureBaseline(origin, me);
    const info = await pullHost.info();
    const pull = info?.[origin];
    if (!pull || pull.state === 'idle' || reason === 'added') await startPull(origin);
    await refreshCounters(origin);
  } catch (e) {
    await handleError(origin, e);
  }
}

// Starts every portal in its own queue, in parallel.
async function initAll(reason) {
  const { portals } = await getSettings();
  if (portals.length) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(TICK_ALARM);
  if (!portals.length) await pullHost.closeAll();
  await Promise.all(portals.map((origin) => enqueueFor(origin, () => init(origin, reason))));
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

// Names and avatars of other users, for events that carry only a user id (group
// calls, reactions). Cached per portal for the life of the background.
const users = new Map();
function userInfo(origin, id) {
  const key = `${origin}|${id}`;
  if (!users.has(key)) {
    users.set(
      key,
      callRest(origin, 'im.user.get', { ID: id })
        .then((u) => ({ name: u?.name || '', avatar: u?.avatar || '' }))
        .catch(() => (users.delete(key), { name: '', avatar: '' })),
    );
  }
  return users.get(key);
}

// A ringing call or a reaction should not wait long for a name lookup.
const within = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
const NO_USER = { name: '', avatar: '' };

const REACTION_EMOJI = { like: '👍', kiss: '😘', laugh: '😂', wonder: '😮', cry: '😢', angry: '😠', facepalm: '🤦' };

const countersTimers = new Map();
function scheduleCounters(origin) {
  clearTimeout(countersTimers.get(origin));
  countersTimers.set(origin, setTimeout(() => enqueueFor(origin, () => refreshCounters(origin)), 1000));
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
        await notifier.clearWhere((e) => mine('reaction')(e) && e.dialogId === a.dialogId);
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
      case 'call': {
        if (!s.notifyCalls || (await quiet())) break;
        // Group calls: say who is calling, not just which chat.
        const caller = a.group && a.initiatorId ? await within(userInfo(origin, a.initiatorId), 2000, NO_USER) : NO_USER;
        await notifier.show(notifId(origin, `call:${a.callId}`), { kind: 'call', origin, callId: a.callId, dialogId: a.dialogId }, {
          title: a.title,
          message: caller.name ? `${caller.name}\n${a.name}` : a.name,
          iconUrl: await notifier.iconFor(caller.avatar || a.avatar, origin),
          buttons: [{ title: t('answer') }],
          requireInteraction: true,
          priority: 2,
          silent: s.silent,
          ...label,
        });
        break;
      }
      case 'reaction': {
        if (!s.notifyReactions || (await quiet())) break;
        const who = await within(userInfo(origin, a.fromUserId), 2000, NO_USER);
        await notifier.show(
          notifId(origin, `reaction:${a.dialogId}:${a.messageId}`),
          { kind: 'reaction', origin, dialogId: a.dialogId, messageId: a.messageId },
          {
            title: who.name || t('systemTitle'),
            message: t('reactedToMessage', [REACTION_EMOJI[a.reaction] || a.reaction]),
            iconUrl: await notifier.iconFor(who.avatar, origin),
            silent: s.silent,
            ...label,
          },
        );
        break;
      }
      case 'dismiss-reactions':
        await notifier.clearWhere((e) => mine('reaction')(e) && e.dialogId === a.dialogId);
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

// The 1-minute watchdog. Each portal is checked in its own queue; a portal whose
// previous check is still running (e.g. it doesn't respond) is skipped this round.
const ticking = new Set();
async function tick() {
  await notifier.clearWhere((e) => e.kind === 'call' && Date.now() - e.shownAt > CALL_RING_MAX_MS);
  await notifier.prune();
  const { portals } = await getSettings();
  const states = await getAllStates(portals);
  const info = states.some((st) => st.auth === 'ok') ? await pullHost.info() : null;
  await Promise.all(
    portals
      .filter((origin) => !ticking.has(origin))
      .map((origin) => {
        ticking.add(origin);
        return enqueueFor(origin, () => tickPortal(origin, info?.[origin])).finally(() => ticking.delete(origin));
      }),
  );
}

async function tickPortal(origin, pull) {
  const st = await getState(origin);
  if (st.auth !== 'ok') return init(origin, 'tick');
  if (!pull || pull.state === 'idle') await startPull(origin);
  else if (pull.state !== st.pull) await setState(origin, { pull: pull.state });
  if (pull?.state !== 'online' || Date.now() - st.lastPollAt > SAFETY_POLL_MS) await catchUp(origin);
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
    // The user is waiting for these, so they get the longer timeout.
    const opts = { timeoutMs: INTERACTIVE_TIMEOUT_MS };
    if (entry.kind === 'chat') await callRest(origin, 'im.dialog.read', { DIALOG_ID: entry.dialogId }, opts);
    else if (entry.kind === 'system') await callRest(origin, 'im.notify.read', { ID: entry.notifyId, ONLY_CURRENT: 'Y' }, opts);
    else await openTarget(entry);
  } catch (e) {
    await handleError(origin, e);
  }
  scheduleCounters(origin);
}

// --------------------------------------------------------------- listeners

const logError = (e) => console.error('[b24n]', e);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // First install: the extension does nothing until a portal is entered, so say so.
  if (reason === 'install') chrome.runtime.openOptionsPage();
  (async () => {
    if (reason === 'update') await migrateStorage();
    await initAll('installed');
  })().catch(logError);
});
chrome.runtime.onStartup.addListener(() => initAll('startup').catch(logError));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) tick().catch(logError);
});

// Clicks run in the queue of the notification's portal.
const portalOf = (id) => notifier.parseNotifId(id).origin;
chrome.notifications.onClicked.addListener((id) => enqueueFor(portalOf(id), () => onClicked(id)));
chrome.notifications.onButtonClicked.addListener((id, index) => enqueueFor(portalOf(id), () => onButtonClicked(id, index)));
chrome.notifications.onClosed.addListener((id) => notifier.forget(id).catch(logError));

chrome.permissions.onAdded.addListener(() => initAll('permission').catch(logError));
chrome.permissions.onRemoved.addListener(() => initAll('permission').catch(logError));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.portals) {
    const before = changes.portals.oldValue || [];
    const after = changes.portals.newValue || [];
    (async () => {
      await Promise.all([
        ...before.filter((o) => !after.includes(o)).map((origin) => enqueueFor(origin, () => forgetPortal(origin))),
        ...after
          .filter((o) => !before.includes(o))
          .map((origin) =>
            enqueueFor(origin, async () => {
              if ((await getState(origin)).auth !== 'ok') await init(origin, 'added');
            }),
          ),
      ]);
      if (after.length) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
      else await chrome.alarms.clear(TICK_ALARM);
      await renderBadge();
    })().catch(logError);
  } else if (changes.muteUntil) {
    renderBadge().catch(logError);
  }
});

// A portal page finished loading while we were logged out: the user probably just logged in.
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status !== 'complete' || !tab.url) return;
  getSettings().then(({ portals }) => {
    const origin = portalForUrl(portals, tab.url);
    if (!origin) return;
    enqueueFor(origin, async () => {
      if ((await getState(origin)).auth !== 'ok') await init(origin, 'portal-tab');
    });
  });
});

// Socket events from the pull host (offscreen document or this page).
pullHost.onMessage((msg) =>
  enqueueFor(msg.origin, async () => {
    // A socket for a portal that has since been removed: shut it down.
    if (!(await getSettings()).portals.includes(msg.origin)) return stopPull(msg.origin);
    if (msg.cmd === 'pull-events') await onPullEvents(msg.origin, msg.events);
    else if (msg.cmd === 'pull-state') await onPullState(msg.origin, msg.state, msg.detail);
    else await startPull(msg.origin, true);
  }),
);

async function stateForUi() {
  const settings = await getSettings();
  return { settings, portals: await getAllStates(settings.portals) };
}

// Re-checks portals that are not connected (e.g. the user has just logged in).
// Connected portals are left alone: their pull connection and the 1-minute tick
// keep them current. Each portal is checked at most once at a time.
const refreshing = new Set();
async function refreshStale(origin) {
  const { portals } = await getSettings();
  for (const st of await getAllStates(origin ? [origin] : portals)) {
    if (st.auth === 'ok' || refreshing.has(st.origin)) continue;
    refreshing.add(st.origin);
    enqueueFor(st.origin, () => init(st.origin, 'refresh')).finally(() => refreshing.delete(st.origin));
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'background') return;
  switch (msg.cmd) {
    // UI requests are answered at once, never behind the work queue: it can be busy
    // for a long time with a portal that is slow to respond.
    case 'get-state':
      stateForUi().then(reply);
      return true;
    case 'refresh':
      // Results reach the UI through storage changes; nothing to wait for.
      refreshStale(msg.origin).finally(() => reply({ ok: true }));
      return true;
    case 'open-portal':
      // Only reads settings and tabs, so it needs no queue.
      openTarget({ kind: 'portal', origin: msg.origin }).catch((e) => console.error('[b24n]', e));
      return;
    case 'test-notification':
      getSettings()
        .then((s) => notifier.show('test', { kind: 'test' }, { title: t('testTitle'), message: t('testBody'), silent: s.silent }))
        .catch(logError);
      return;
    default:
  }
});

// Debug handle for the background DevTools console (also used by E2E scripts).
globalThis.b24n = {
  init: (origin) => (origin ? enqueueFor(origin, () => init(origin, 'debug')) : initAll('debug')),
  tick,
  catchUp: (origin) => enqueueFor(origin, () => catchUp(origin)),
  click: (id) => enqueueFor(portalOf(id), () => onClicked(id)),
  button: (id, index = 0) => enqueueFor(portalOf(id), () => onButtonClicked(id, index)),
};
