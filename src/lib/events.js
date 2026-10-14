// Maps raw Push&Pull commands to notification actions. Pure: no chrome.* calls,
// so it can be unit-tested. See docs/protocol.md for the payload shapes.
//
// Action kinds:
//   chat           { dialogId, messageId, title, body, avatar, group }
//   system         { notifyId, title, body, link, avatar, silent }
//   call           { callId, dialogId, title, video, avatar }
//   missed-call    { callId, dialogId, title, avatar }
//   dismiss-chat   { dialogId, lastId }
//   dismiss-chats  {}
//   dismiss-system { ids: [] }  (empty ids = all)
//   dismiss-call   { callId }
//   seen           { dialogId, messageId }  (advance the cursor without notifying)
//   counters       {}           (unread counters changed)

import { toPlainText, truncate, extractUrl, userName } from './format.js';

const BODY_MAX = 300;

const defaultT = (key, subs) => ({
  file: '[File]',
  incomingCall: 'Incoming call',
  incomingVideoCall: 'Incoming video call',
  missedCall: 'Missed call',
  systemTitle: 'Bitrix24',
}[key] ?? key) + (subs ? ` ${[].concat(subs).join(' ')}` : '');

const isMe = (id, myId) => id != null && String(id) === String(myId);

const isMuted = (muteList, myId) => {
  if (!muteList) return false;
  if (Array.isArray(muteList)) return muteList.map(String).includes(String(myId));
  return muteList[myId] === true || muteList[String(myId)] === true;
};

function fromMessage(p, { myId, t }) {
  const m = p.message;
  if (!m || !m.id) return [];
  const dialogId = String(p.dialogId ?? m.recipientId);

  // Sent by the current user from another device: treat the dialog as read.
  if (isMe(m.senderId, myId)) return [{ kind: 'dismiss-chat', dialogId, lastId: m.id }, { kind: 'counters' }];

  const mp = m.params && !Array.isArray(m.params) ? m.params : {};
  const chat = p.chat && !Array.isArray(p.chat) ? p.chat[p.chatId] : null;
  if (
    m.system === 'Y' ||
    p.notify === false ||
    mp.NOTIFY === 'N' ||
    mp.COMPONENT_ID === 'CallMessage' ||
    isMuted(chat?.mute_list, myId)
  ) {
    return [{ kind: 'seen', dialogId, messageId: Number(m.id) }, { kind: 'counters' }];
  }

  const sender = p.users?.[m.senderId];
  let text = toPlainText(m.text, { fileLabel: t('file') });
  if (!text && (p.files && Object.keys(p.files).length || mp.FILE_ID)) text = t('file');

  const group = dialogId.startsWith('chat');
  const senderName = userName(sender);
  return [
    {
      kind: 'chat',
      dialogId,
      messageId: Number(m.id),
      title: group ? chat.name || senderName : senderName || chat?.name || '',
      body: truncate(group && senderName ? `${senderName}: ${text}` : text, BODY_MAX),
      avatar: sender?.avatar || (group ? chat?.avatar : '') || '',
      group,
    },
    { kind: 'counters' },
  ];
}

function fromNotifyAdd(p, { t }) {
  if (!p.id) return [];
  const cp = p.params?.COMPONENT_PARAMS || {};
  let body = toPlainText(p.text);
  const extra = toPlainText(cp.plainText || cp.PLAIN_TEXT || '');
  if (extra) body = body ? `${body}\n${extra}` : extra;
  return [
    {
      kind: 'system',
      notifyId: Number(p.id),
      title: toPlainText(p.title) || p.userName || t('systemTitle'),
      body: truncate(body, BODY_MAX),
      link: p.link || extractUrl(cp.subject || cp.SUBJECT) || extractUrl(p.text),
      avatar: p.userAvatar || '',
      silent: p.silent === 'Y',
    },
    { kind: 'counters' },
  ];
}

// notifyRead / notifyDelete carry ids as `list: [..]`, `id: N` or `id: {N: …}`.
function notifyIds(p) {
  if (Array.isArray(p.list)) return p.list.map(Number);
  if (typeof p.id === 'number' || typeof p.id === 'string') return [Number(p.id)];
  if (p.id && typeof p.id === 'object') return Object.keys(p.id).map(Number);
  return [];
}

function fromIm(command, p, ctx) {
  switch (command) {
    case 'message':
    case 'messageChat':
      return fromMessage(p, ctx);
    case 'notifyAdd':
      return fromNotifyAdd(p, ctx);
    case 'notifyRead':
    case 'notifyDelete': {
      const ids = notifyIds(p);
      return ids.length ? [{ kind: 'dismiss-system', ids }, { kind: 'counters' }] : [{ kind: 'counters' }];
    }
    case 'notifyReadAll':
    case 'notifyDeleteAll':
      return [{ kind: 'dismiss-system', ids: [] }, { kind: 'counters' }];
    case 'readMessage':
    case 'readMessageChat':
      return [{ kind: 'dismiss-chat', dialogId: String(p.dialogId), lastId: Number(p.lastId) || Infinity }, { kind: 'counters' }];
    case 'chatMuteNotify':
      return p.muted || p.mute ? [{ kind: 'dismiss-chat', dialogId: String(p.dialogId), lastId: Infinity }, { kind: 'counters' }] : [];
    case 'chatHide':
      return [{ kind: 'dismiss-chat', dialogId: String(p.dialogId), lastId: Infinity }];
    case 'readAllChats':
      return [{ kind: 'dismiss-chats' }, { kind: 'counters' }];
    case 'unreadMessage':
    case 'unreadMessageChat':
    case 'messageDelete':
    case 'messageDeleteComplete':
      return [{ kind: 'counters' }];
    default:
      return [];
  }
}

function fromCall(command, p, { myId, t }) {
  switch (command) {
    case 'Call::incoming': {
      const call = p.call || {};
      if (isMe(call.initiatorId, myId)) return [];
      const ae = call.associatedEntity || {};
      // For a private chat the dialog is addressed by the other user's id.
      const isPrivate = ae.advanced?.chatType === 'private';
      const dialogId = isPrivate && call.initiatorId ? String(call.initiatorId) : ae.chatId ? `chat${ae.chatId}` : String(ae.id || '');
      return [
        {
          kind: 'call',
          callId: Number(p.callId),
          dialogId,
          title: t(p.video ? 'incomingVideoCall' : 'incomingCall'),
          name: ae.name || '',
          video: !!p.video,
          avatar: ae.avatar || '',
        },
      ];
    }
    case 'Call::usersAnswered':
    case 'Call::usersDeclined': {
      const senders = p.senders || [];
      return senders.some((s) => isMe(s.senderId, myId)) ? [{ kind: 'dismiss-call', callId: Number(p.callId) }] : [];
    }
    case 'Call::answer':
    case 'Call::hangup':
      return isMe(p.senderId, myId) ? [{ kind: 'dismiss-call', callId: Number(p.callId) }] : [];
    case 'Call::finish':
      return [{ kind: 'dismiss-call', callId: Number(p.callId) }];
    case 'Call::callLogAdd': {
      const actions = [{ kind: 'dismiss-call', callId: Number(p.sourceCallId) }];
      if (p.status === 'missed' && p.type === 'incoming' && (p.userId == null || isMe(p.userId, myId))) {
        const d = p.callData || {};
        actions.push({
          kind: 'missed-call',
          callId: Number(p.sourceCallId),
          dialogId: String(d.dialogId || ''),
          title: t('missedCall'),
          name: d.title || '',
          avatar: d.avatar || '',
        });
      }
      return actions;
    }
    default:
      return [];
  }
}

// `text` is the pull message's `text` object: { module_id, command, params }.
export function interpret(text, { myId, t = defaultT } = {}) {
  if (!text || !text.command) return [];
  const p = text.params || {};
  const ctx = { myId, t };
  switch (text.module_id) {
    case 'im':
      return fromIm(text.command, p, ctx);
    case 'call':
      return fromCall(text.command, p, ctx);
    default:
      return [];
  }
}
