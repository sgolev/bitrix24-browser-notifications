// Unit tests for the pure modules. Open chrome-extension://<id>/tests/tests.html;
// the result is shown on the page and in document.title ("PASS n" / "FAIL n").
// Fixtures are trimmed copies of real payloads (see docs/protocol.md).

import { toPlainText, truncate, extractUrl, absoluteUrl } from '../src/lib/format.js';
import { interpret } from '../src/lib/events.js';
import { buildUrl, parseFrame, backoffDelay, configExpiry, PullClient, State } from '../src/lib/pull.js';
import { recentToActions, notificationsToActions, totalUnread } from '../src/lib/poller.js';
import { normalizePortalUrl } from '../src/lib/settings.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
const ok = (cond, msg = 'expected truthy') => {
  if (!cond) throw new Error(msg);
};

// ------------------------------------------------------------------ fixtures

const ME = 18;
const users = {
  20: { id: 20, name: 'Prokhor James', avatar: '' },
  18: { id: 18, name: 'Wazgen Amosov', avatar: '' },
};

const privateMessage = {
  module_id: 'im',
  command: 'message',
  params: {
    chatId: 20,
    dialogId: 20,
    chat: [],
    users,
    message: { id: 78, chatId: 20, senderId: 20, recipientId: '18', system: 'N', text: 'Привет! [b]Test[/b] private message from B', params: [] },
    files: [],
    notify: true,
  },
};

const groupChat = {
  30: { id: 30, dialogId: 'chat30', name: 'Ext test chat', avatar: '/bitrix/js/im/images/blank.gif', mute_list: { 18: false, 20: false }, type: 'chat' },
};

const groupMessage = {
  module_id: 'im',
  command: 'messageChat',
  params: {
    chatId: 30,
    dialogId: 'chat30',
    chat: groupChat,
    users: { 20: users[20] },
    message: {
      id: 86,
      chatId: 30,
      senderId: 20,
      recipientId: 'chat30',
      system: 'N',
      text: 'Group hello with mention [USER=18]A[/USER] and link [URL=https://example.com]ex[/URL]',
      params: [],
    },
    files: [],
    notify: true,
  },
};

const notifyAdd = {
  module_id: 'im',
  command: 'notifyAdd',
  params: {
    id: 90,
    type: 2,
    silent: 'N',
    link: '',
    text: 'Создал задачу [#2] Ext test task',
    originalTag: 'TASKS|TASK|2|18',
    params: {
      COMPONENT_ID: 'DefaultEntity',
      COMPONENT_PARAMS: {
        subject: '#AUTHOR# создал задачу [URL=https://portal.example/company/personal/user/18/tasks/task/view/2/]#2[/URL]',
        plainText: 'Исполнитель: Wazgen Amosov\r\nКрайний срок: 18 октября, 19:00',
      },
    },
    userId: 20,
    userName: 'Prokhor James',
    userAvatar: '/bitrix/js/im/images/blank.gif',
    title: '',
  },
};

const callIncoming = {
  module_id: 'call',
  command: 'Call::incoming',
  params: {
    callId: 2,
    video: true,
    isRepeated: false,
    call: {
      initiatorId: 20,
      associatedEntity: { type: 'chat', id: '20', chatId: 20, name: 'Prokhor James', avatar: '/bitrix/js/im/images/blank.gif', advanced: { chatType: 'private' } },
    },
  },
};

const pullConfig = {
  server: {
    version: 4,
    mode: 'personal',
    hostname: 'portal.example',
    websocket_enabled: true,
    websocket_secure: 'wss://rtc.example/subws2/',
  },
  channels: {
    shared: { id: 'shared.sig', end: '2026-10-13T09:46:29+03:00' },
    private: { id: 'priv:pub.sig', end: '2026-10-13T10:24:28+03:00' },
  },
  exp: 1791926748,
};

const frame = (...texts) =>
  texts.map((text, i) => `#!NGINXNMS!#${JSON.stringify({ id: i, mid: `mid${i}`, text })}#!NGINXNME!#`).join('');

// --------------------------------------------------------------------- format

test('toPlainText strips BBCode and HTML, keeps inner text', () => {
  eq(toPlainText('Привет! [b]Test[/b] [USER=18]Ann[/USER] [URL=https://x.y]link[/URL]'), 'Привет! Test Ann link');
  eq(toPlainText('<b>Bold</b><br />next &amp; &quot;q&quot;'), 'Bold\nnext & "q"');
  eq(toPlainText('[USER=20 REPLACE]Prokhor James[/USER] создал чат'), 'Prokhor James создал чат');
  eq(toPlainText('[DISK=12]', { fileLabel: '[Файл]' }), '[Файл]');
  eq(toPlainText('see [ICON=https://x/y.png title=t] here'), 'see here');
});

test('toPlainText drops quoted replies', () => {
  const dashes = '-'.repeat(54);
  eq(toPlainText(`${dashes}\nAnn [12.10.2026]\nold text\n${dashes}\nmy reply`), 'my reply');
});

test('truncate / extractUrl / absoluteUrl', () => {
  eq(truncate('abcdef', 4), 'abc…');
  eq(truncate('abc', 4), 'abc');
  eq(extractUrl('x [URL=https://a.b/c?d=1]t[/URL]'), 'https://a.b/c?d=1');
  eq(extractUrl('<a href="https://a.b/&amp;x">t</a>'), 'https://a.b/&x');
  eq(absoluteUrl('/upload/a.png', 'https://p.example'), 'https://p.example/upload/a.png');
  eq(absoluteUrl('/bitrix/js/im/images/blank.gif', 'https://p.example'), '');
  eq(absoluteUrl('', 'https://p.example'), '');
});

test('normalizePortalUrl', () => {
  eq(normalizePortalUrl('b24-x.bitrix24.ru'), 'https://b24-x.bitrix24.ru');
  eq(normalizePortalUrl(' https://b24-x.bitrix24.ru/online/?a=1 '), 'https://b24-x.bitrix24.ru');
  eq(normalizePortalUrl('http://intranet.local:8080/'), 'http://intranet.local:8080');
  eq(normalizePortalUrl('nonsense'), '');
  eq(normalizePortalUrl(''), '');
});

// --------------------------------------------------------------------- events

test('private message → chat action', () => {
  const [a, c] = interpret(privateMessage, { myId: ME });
  eq(a, { kind: 'chat', dialogId: '20', messageId: 78, title: 'Prokhor James', body: 'Привет! Test private message from B', avatar: '', group: false });
  eq(c.kind, 'counters');
});

test('group message → chat action titled with chat name, body prefixed with sender', () => {
  const [a] = interpret(groupMessage, { myId: ME });
  eq(a.title, 'Ext test chat');
  eq(a.body, 'Prokhor James: Group hello with mention A and link ex');
  eq(a.dialogId, 'chat30');
  eq(a.group, true);
});

test('own message → dismiss dialog', () => {
  const own = structuredClone(privateMessage);
  own.params.message.senderId = ME;
  eq(interpret(own, { myId: ME })[0], { kind: 'dismiss-chat', dialogId: '20', lastId: 78 });
});

test('system / NOTIFY=N / call / muted messages are only marked seen', () => {
  const variants = [
    (m) => (m.params.message.system = 'Y'),
    (m) => (m.params.message.params = { NOTIFY: 'N' }),
    (m) => (m.params.message.params = { COMPONENT_ID: 'CallMessage', NOTIFY: 'Y' }),
    (m) => (m.params.chat[30].mute_list[ME] = true),
    (m) => (m.params.notify = false),
  ];
  for (const change of variants) {
    const m = structuredClone(groupMessage);
    change(m);
    eq(interpret(m, { myId: ME }).map((a) => a.kind), ['seen', 'counters'], change.toString());
  }
});

test('file-only message gets the file label', () => {
  const m = structuredClone(privateMessage);
  m.params.message.text = '';
  m.params.files = { 5: { id: 5 } };
  eq(interpret(m, { myId: ME, t: (k) => (k === 'file' ? '[Файл]' : k) })[0].body, '[Файл]');
});

test('notifyAdd → system action with link and details', () => {
  const [a] = interpret(notifyAdd, { myId: ME });
  eq(a.kind, 'system');
  eq(a.notifyId, 90);
  eq(a.title, 'Prokhor James');
  eq(a.body, 'Создал задачу [#2] Ext test task\nИсполнитель: Wazgen Amosov\nКрайний срок: 18 октября, 19:00');
  eq(a.link, 'https://portal.example/company/personal/user/18/tasks/task/view/2/');
});

test('read events → dismiss actions', () => {
  eq(interpret({ module_id: 'im', command: 'notifyRead', params: { list: [90] } })[0], { kind: 'dismiss-system', ids: [90] });
  eq(interpret({ module_id: 'im', command: 'notifyReadAll', params: {} })[0], { kind: 'dismiss-system', ids: [] });
  eq(interpret({ module_id: 'im', command: 'readMessageChat', params: { dialogId: '20', lastId: 78 } })[0], {
    kind: 'dismiss-chat',
    dialogId: '20',
    lastId: 78,
  });
  eq(interpret({ module_id: 'im', command: 'readAllChats', params: {} })[0], { kind: 'dismiss-chats' });
});

test('incoming call → call action addressed to the caller dialog', () => {
  const [a] = interpret(callIncoming, { myId: ME });
  eq(a, { kind: 'call', callId: 2, dialogId: '20', title: 'Incoming video call', name: 'Prokhor James', video: true, avatar: '/bitrix/js/im/images/blank.gif' });
  eq(interpret(callIncoming, { myId: 20 }), [], 'own outgoing call is ignored');
});

test('call lifecycle → dismiss / missed', () => {
  eq(interpret({ module_id: 'call', command: 'Call::finish', params: { callId: 2 } }), [{ kind: 'dismiss-call', callId: 2 }]);
  eq(interpret({ module_id: 'call', command: 'Call::usersAnswered', params: { callId: 2, senders: [{ senderId: 20 }] } }, { myId: ME }), []);
  eq(interpret({ module_id: 'call', command: 'Call::usersAnswered', params: { callId: 2, senders: [{ senderId: 18 }] } }, { myId: ME }), [
    { kind: 'dismiss-call', callId: 2 },
  ]);
  const missed = interpret(
    {
      module_id: 'call',
      command: 'Call::callLogAdd',
      params: { sourceCallId: 2, userId: 18, status: 'missed', type: 'incoming', callData: { dialogId: '20', title: 'Prokhor James', avatar: '' } },
    },
    { myId: ME },
  );
  eq(missed.map((a) => a.kind), ['dismiss-call', 'missed-call']);
  eq(missed[1].dialogId, '20');
});

test('unknown modules and commands are ignored', () => {
  eq(interpret({ module_id: 'tasks', command: 'task_add', params: {} }, { myId: ME }), []);
  eq(interpret({ module_id: 'im', command: 'urlAdd', params: {} }, { myId: ME }), []);
  eq(interpret(null), []);
});

// ----------------------------------------------------------------------- pull

test('buildUrl uses channels, hostname, revision and mid', () => {
  const url = new URL(buildUrl(pullConfig, { mid: 'm1' }));
  eq(url.origin + url.pathname, 'wss://rtc.example/subws2/');
  eq(url.searchParams.get('CHANNEL_ID'), 'priv:pub.sig/shared.sig');
  eq(url.searchParams.get('hostname'), 'portal.example');
  eq(url.searchParams.get('revision'), '19');
  eq(url.searchParams.get('mid'), 'm1');
  ok(!url.searchParams.has('binaryMode'));
  const jwt = new URL(buildUrl({ ...pullConfig, jwt: 'J' }));
  eq(jwt.searchParams.get('token'), 'J');
  ok(!jwt.searchParams.has('CHANNEL_ID'));
  eq(buildUrl({ server: {} }), null);
});

test('parseFrame handles multiple blocks, JSON arrays and garbage', () => {
  eq(parseFrame(frame({ a: 1 }, { b: 2 })).map((m) => m.text), [{ a: 1 }, { b: 2 }]);
  eq(parseFrame('#!NGINXNMS!#{bad#!NGINXNME!##!NGINXNMS!#{"text":1}#!NGINXNME!#'), [{ text: 1 }]);
  eq(parseFrame('[{"text":{"x":1}}]'), [{ text: { x: 1 } }]);
  eq(parseFrame('nope'), []);
  eq(parseFrame(new ArrayBuffer(2)), []);
});

test('backoffDelay and configExpiry', () => {
  eq([0, 1, 3, 5, 10].map((n) => backoffDelay(n, () => 0)), [0.5, 5, 25, 45, 60]);
  eq(backoffDelay(10, () => 1), 72);
  eq(configExpiry(pullConfig), Date.parse('2026-10-13T09:46:29+03:00'));
});

// Fake socket + timers to drive PullClient deterministically.
function harness() {
  const sockets = [];
  const timers = new Map();
  let nextTimer = 0;
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const out = { events: [], states: [], needConfig: [] };
  const client = new PullClient({
    WebSocketImpl: FakeSocket,
    onEvents: (e) => out.events.push(...e),
    onState: (s) => out.states.push(s),
    onNeedConfig: (r) => out.needConfig.push(r),
    setTimer: (fn) => (timers.set(++nextTimer, fn), nextTimer),
    clearTimer: (id) => timers.delete(id),
    now: () => Date.parse('2026-10-13T00:00:00+03:00'),
    random: () => 0,
  });
  const runTimers = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { client, sockets, timers, out, runTimers };
}

test('PullClient connects, forwards events, skips pull/online and duplicates', () => {
  const { client, sockets, out } = harness();
  client.start(structuredClone(pullConfig));
  eq(sockets.length, 1);
  sockets[0].onopen();
  eq(client.state, State.ONLINE);
  sockets[0].onmessage({ data: frame(privateMessage, { module_id: 'online', command: 'list', params: {} }) });
  sockets[0].onmessage({ data: frame(privateMessage) }); // same mid0 again
  eq(out.events.length, 1);
  eq(out.events[0].command, 'message');
  eq(client.mid, 'mid1', 'last mid, including skipped presence events');
});

test('PullClient reconnects with mid after a drop and asks for config after repeated failures', () => {
  const { client, sockets, out, runTimers } = harness();
  client.start(structuredClone(pullConfig));
  sockets[0].onopen();
  sockets[0].onmessage({ data: frame(privateMessage) });
  sockets[0].onclose({ code: 1006 });
  eq(client.state, State.OFFLINE);
  runTimers();
  eq(sockets.length, 2);
  eq(new URL(sockets[1].url).searchParams.get('mid'), 'mid0');
  for (let i = 0; i < 3; i++) {
    sockets.at(-1).onclose({ code: 1006 });
    runTimers();
  }
  ok(out.needConfig.includes('connect-failed'), 'needConfig after 3 failures');
});

test('PullClient handles channel_expire reconnect and config_expire', () => {
  const { client, sockets, out } = harness();
  client.start(structuredClone(pullConfig));
  sockets[0].onopen();
  sockets[0].onmessage({
    data: frame({ module_id: 'pull', command: 'channel_expire', params: { action: 'reconnect', channel: { type: 'shared' }, new_channel: { id: 'new.sig', end: '2026-10-14T00:00:00+03:00' } } }),
  });
  eq(sockets.length, 2);
  ok(sockets[0].closed);
  eq(new URL(sockets[1].url).searchParams.get('CHANNEL_ID'), 'priv:pub.sig/new.sig');
  sockets[1].onopen();
  sockets[1].onmessage({ data: '#!NGINXNMS!#{"mid":"x9","text":{"module_id":"pull","command":"config_expire","params":{}}}#!NGINXNME!#' });
  eq(out.needConfig, ['config-expired']);
});

test('PullClient: disabled websocket and stop()', () => {
  const { client, sockets } = harness();
  client.start({ ...structuredClone(pullConfig), server: { ...pullConfig.server, websocket_enabled: false } });
  eq(client.state, State.DISABLED);
  eq(sockets.length, 0);
  client.start(structuredClone(pullConfig));
  client.stop();
  ok(sockets[0].closed);
  eq(client.state, State.IDLE);
});

// --------------------------------------------------------------------- poller

const recentItems = [
  {
    id: 'chat30',
    title: 'Ext test chat',
    avatar: { url: '' },
    counter: 2,
    message: { id: 92, text: 'Quotes "test" and link', author_id: 20, date: '2026-10-13T00:28:05+03:00', file: false },
    chat: { mute_list: [] },
    user: { id: 20, name: 'Prokhor James' },
  },
  {
    id: 20,
    title: 'Prokhor James',
    avatar: { url: '' },
    counter: 0,
    message: { id: 78, text: 'read already', author_id: 20, date: '2026-10-13T00:26:57+03:00' },
    user: { id: 20, name: 'Prokhor James' },
  },
  {
    id: 'chat40',
    title: 'Muted',
    counter: 1,
    message: { id: 99, text: 'x', author_id: 20, date: '2026-10-13T00:28:05+03:00' },
    chat: { mute_list: [18] },
  },
];

test('recentToActions notifies unread, unseen, unmuted dialogs only', () => {
  const now = Date.parse('2026-10-13T00:30:00+03:00');
  const { actions, seen } = recentToActions(recentItems, { myId: ME, lastSeen: { 20: 70 }, now, maxAgeMs: 3600e3 });
  eq(actions.map((a) => [a.dialogId, a.body]), [['chat30', 'Prokhor James: Quotes "test" and link']]);
  eq(seen, { chat30: 92, 20: 78, chat40: 99 });
  eq(recentToActions(recentItems, { myId: ME, lastSeen: { chat30: 92 }, now }).actions.length, 0, 'already seen');
  eq(recentToActions(recentItems, { myId: ME, lastSeen: {}, now: now + 7200e3, maxAgeMs: 3600e3 }).actions.length, 0, 'too old');
});

test('notificationsToActions returns unread newer notifications in id order', () => {
  const result = {
    notifications: [
      { id: 95, author_id: 20, date: '2026-10-13T00:29:00+03:00', text: 'second', notify_read: 'N', params: [] },
      { id: 90, author_id: 20, date: '2026-10-13T00:27:11+03:00', text: 'Создал задачу', notify_read: 'N', params: { COMPONENT_PARAMS: { SUBJECT: '[URL=https://p/t/2/]x[/URL]' } } },
      { id: 80, author_id: 20, date: '2026-10-13T00:20:00+03:00', text: 'old', notify_read: 'N' },
      { id: 85, author_id: 20, date: '2026-10-13T00:21:00+03:00', text: 'read', notify_read: 'Y' },
    ],
    users: [{ id: 20, name: 'Prokhor James' }],
  };
  const { actions, maxId } = notificationsToActions(result, { lastNotifyId: 85, now: Date.parse('2026-10-13T00:30:00+03:00') });
  eq(actions.map((a) => a.notifyId), [90, 95]);
  eq(actions[0].title, 'Prokhor James');
  eq(actions[0].link, 'https://p/t/2/');
  eq(maxId, 95);
});

test('totalUnread', () => {
  eq(totalUnread({ TYPE: { ALL: 6, NOTIFY: 1, CHAT: 3, DIALOG: 1, LINES: 0, MESSENGER: 5 } }), 5);
  eq(totalUnread({ TYPE: { NOTIFY: 1, CHAT: 3, DIALOG: 1 } }), 5);
  eq(totalUnread(null), 0);
});

// ----------------------------------------------------------------------- run

let failed = 0;
const list = document.getElementById('results');
for (const { name, fn } of tests) {
  const li = document.createElement('li');
  try {
    await fn();
    li.className = 'pass';
    li.textContent = `✓ ${name}`;
  } catch (e) {
    failed++;
    li.className = 'fail';
    li.textContent = `✗ ${name}\n${e.message}`;
  }
  list.append(li);
}
const summary = failed ? `FAIL ${failed}/${tests.length}` : `PASS ${tests.length}`;
document.getElementById('summary').textContent = summary;
document.title = summary;
