// REST polling: the fallback when the real-time connection is down, and the
// catch-up after (re)connecting. Converts REST results into the same actions
// that events.js produces for pull events.

import { toPlainText, truncate, extractUrl, userName } from './format.js';

const BODY_MAX = 300;

const isMuted = (muteList, myId) =>
  Array.isArray(muteList) ? muteList.map(String).includes(String(myId)) : !!muteList?.[myId];

// im.recent.list items → chat actions for unread messages newer than `lastSeen[dialogId]`.
// Messages older than `maxAgeMs` only advance the cursor.
export function recentToActions(items, { myId, lastSeen, now = Date.now(), maxAgeMs, fileLabel = '[File]' }) {
  const actions = [];
  const seen = {};
  for (const item of items || []) {
    const msg = item.message;
    const dialogId = String(item.id);
    if (!msg?.id) continue;
    seen[dialogId] = Math.max(Number(msg.id), Number(lastSeen[dialogId]) || 0);
    if (Number(msg.id) <= (Number(lastSeen[dialogId]) || 0)) continue;
    if (!item.counter || String(msg.author_id) === String(myId) || !Number(msg.author_id)) continue;
    if (isMuted(item.chat?.mute_list, myId)) continue;
    if (maxAgeMs && now - Date.parse(msg.date) > maxAgeMs) continue;

    const group = dialogId.startsWith('chat');
    let text = toPlainText(msg.text, { fileLabel }) || (msg.file ? fileLabel : '');
    const author = item.user && String(item.user.id) === String(msg.author_id) ? userName(item.user) : '';
    if (group && author) text = `${author}: ${text}`;
    actions.push({
      kind: 'chat',
      dialogId,
      messageId: Number(msg.id),
      title: item.title || author,
      body: truncate(text, BODY_MAX),
      avatar: item.avatar?.url || (group ? '' : item.user?.avatar) || '',
      group,
      count: item.counter,
    });
  }
  return { actions, seen };
}

// im.notify.get result → system actions for unread notifications newer than `lastNotifyId`.
export function notificationsToActions(result, { lastNotifyId, now = Date.now(), maxAgeMs, systemTitle = 'Bitrix24' }) {
  const actions = [];
  let maxId = Number(lastNotifyId) || 0;
  const users = new Map((result?.users || []).map((u) => [String(u.id), u]));
  for (const n of result?.notifications || []) {
    const id = Number(n.id);
    if (id > maxId) maxId = id;
    if (id <= (Number(lastNotifyId) || 0) || n.notify_read === 'Y') continue;
    if (maxAgeMs && now - Date.parse(n.date) > maxAgeMs) continue;
    const cp = n.params?.COMPONENT_PARAMS || {};
    const author = users.get(String(n.author_id));
    let body = toPlainText(n.text);
    const extra = toPlainText(cp.PLAIN_TEXT || cp.plainText || '');
    if (extra) body = body ? `${body}\n${extra}` : extra;
    actions.push({
      kind: 'system',
      notifyId: id,
      title: toPlainText(n.notify_title) || userName(author) || systemTitle,
      body: truncate(body, BODY_MAX),
      link: extractUrl(cp.SUBJECT || cp.subject) || extractUrl(n.text),
      avatar: author?.avatar || '',
      silent: false,
    });
  }
  actions.sort((a, b) => a.notifyId - b.notifyId);
  return { actions, maxId };
}

// Badge number from im.counters.get.
export function totalUnread(counters) {
  const t = counters?.TYPE || {};
  if (typeof t.MESSENGER === 'number') return t.MESSENGER;
  return (t.CHAT || 0) + (t.DIALOG || 0) + (t.NOTIFY || 0) + (t.LINES || 0);
}
