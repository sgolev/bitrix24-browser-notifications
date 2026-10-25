# Bitrix24 protocol notes

This file records what the extension relies on. Everything here was observed on a live Bitrix24 cloud portal (pull server version 4, `api.revision_web` 19) in October 2026. None of these are documented public APIs, so re-check them here when something breaks.

## Session REST

- **Endpoint.** `POST https://<portal>/rest/<method>.json?sessid=<sessid>`. Send the body as JSON and include cookies (`credentials: 'include'`).
- **Without `sessid`.** The call fails with HTTP 401 `{"error":"NO_AUTH_FOUND"}`.
- **With a wrong `sessid` while logged in.** The call fails with HTTP 401 `{"error":"session_failed","sessid":"<correct sessid>"}`. The client takes `sessid` from that response and retries, so it never has to load a portal page.
- **Requests from the extension.** They are allowed when the extension has host permission for the portal origin. The pull WebSocket also accepts an `Origin: chrome-extension://…` header.

## Methods used

| Method | Purpose |
| --- | --- |
| `im.user.get` | Current user (`id`, `name`, `avatar`). With `ID`, another user: used for group-call callers and reactions, whose events carry only a user id. |
| `pull.config.get` (`CACHE: 'N'` to force a fresh one) | Push&Pull connection config. |
| `im.counters.get` | `TYPE.{MESSENGER,CHAT,DIALOG,NOTIFY,LINES}` unread counters, used for the badge. |
| `im.recent.list` (`LIMIT`) | Recent dialogs. Each item has `id` (dialogId), `title`, `counter` (unread), `message.{id,text,author_id,date,file}` and `chat.mute_list`. Used for the polling fallback. |
| `im.notify.get` (`LIMIT`) | Bell notifications: `notifications[].{id,author_id,text,notify_read,params.COMPONENT_PARAMS.SUBJECT}` and `users[]`. |
| `im.dialog.read` (`DIALOG_ID`) | "Mark as read" for chats. |
| `im.notify.read` (`ID`, `ONLY_CURRENT: 'Y'`) | "Mark as read" for bell notifications. |

## Push&Pull config (`pull.config.get`)

```json
{"server":{"version":4,"mode":"personal","hostname":"<portal host>",
  "websocket_enabled":true,"websocket_secure":"wss://rtc-v2-ms7.bitrix24.com/subws2/", ...},
 "api":{"revision_web":19},
 "channels":{"private":{"id":"…","end":"<ISO date>"},"shared":{"id":"…","end":"<ISO date>"}},
 "exp":1791926748}
```

Channels live for 12 hours. The extension refreshes the config before the earliest `channels.*.end` or `exp`, whichever comes first.

## WebSocket

- **URL.** `<websocket_secure>?CHANNEL_ID=<private.id>/<shared.id>&hostname=<server.hostname>&revision=19`, plus `&mid=<last mid>` to restore missed messages after a reconnect.
- **Optional parameters.** Add `clientId` when the server runs in `shared` mode. When the config has `jwt`, use `token=<jwt>` instead of `CHANNEL_ID`.
- **Binary mode.** The portal's own client adds `binaryMode=true` (protobuf). The extension leaves it out and gets text frames instead.
- **Frame format.** Each text frame holds one or more `#!NGINXNMS!#{json}#!NGINXNME!#` blocks. Each block is `{"id","mid","channel","tag","time","text":{"module_id","command","params","extra"}}`. `format=json` changes nothing on this server.
- **Keepalive.** The server sends no keepalive frames, and the portal client does not ping in this (non-JSON-RPC) mode. A connection that sent nothing stayed open for at least 20 minutes and kept receiving events.
- **Internal commands** (`module_id: "pull"`):
  - `channel_expire`: if `params.action == "reconnect"`, replace `channels[params.channel.type]` with `params.new_channel` and reconnect. Otherwise fetch a new config.
  - `config_expire`: fetch a new config.
  - `server_restart`: reconnect after a delay.

## Events that matter

All of these are `text.module_id` / `text.command` pairs.

| Event | Payload |
| --- | --- |
| `im` / `message` (private) and `im` / `messageChat` (group) | `params.dialogId` (the sender's user id for private chats, `chatNN` for groups), `params.chatId`, `params.message.{id,senderId,system,text (BBCode),params}`, `params.users{id:{name,avatar}}`, `params.chat{chatId:{name,mute_list{userId:bool},type}}`, `params.notify`. |
| `im` / `notifyAdd` | `params.{id,type,text,title,link,silent,userName,userAvatar,originalTag,settingName,params.COMPONENT_PARAMS.{subject,plainText}}`. Every bell notification from any module arrives this way. Observed `settingName` values include `tasks\|manage`, `calendar\|invite`, and feed mentions, comments and likes. `type: 1` is an invitation with `params.BUTTONS[]` (`{TITLE, VALUE, TYPE: accept/cancel}`). |
| `im` / `notifyRead` | `params.list` = notification ids. |
| `im` / `readMessageChat` | Sent for private chats too. `params.{dialogId,chatId,lastId,counter}`. |
| `im` / `addAnchor` | `params.{dialogId,chatId,messageId,fromUserId,type,subType}`. Sent only to the user an item is addressed to. `type: "reaction"` (`subType`: `like`, …) means someone reacted to *your* message. `type: "mention"` comes together with the mentioning message. |
| `im` / `deleteChatAnchors` | `params.{dialogId,chatId,userId}`. Sent when you read the dialog; clears its anchors (and the extension's reaction notifications). |
| `im` / `addReaction`, `im` / `messageLike` | Reaction details, broadcast to all chat members (`addReaction.params.actualReactions.usersShort[].name`). Not used: `addAnchor` already tells who the reaction is for. |
| `call` / `Call::incoming` | `params.{callId,video,isRepeated,call.{initiatorId,associatedEntity.{id,chatId,name,avatar,advanced.chatType}}}`. For a group call, `associatedEntity` is the chat (`advanced.chatType: "chat"`), and the caller is only `initiatorId`. `video: false` means an audio call. |
| `call` / `Call::usersAnswered` | `params.{callId,senders[].senderId}`. |
| `call` / `Call::hangup` | `params.{callId,senderId}`. With your `senderId`: you declined or left on another device. |
| `call` / `Call::finish` | `params.callId`. |
| `call` / `Call::callLogAdd` | `params.{status,type:"incoming",userId,sourceCallId,callData.{dialogId,title,avatar}}`. `status` is `"missed"` (no answer) or `"declined"`. |

Call-related messages also show up in the chat as `params.message.params.COMPONENT_ID == "CallMessage"`. These need to be ignored, because the call events above already cover them.

Other message flags seen in practice:
- **Task comments** arrive as `messageChat` in the task's chat (`chat.type: "tasksTask"`, `entity_type: "TASKS_TASK"`) with `message.params.NOTIFY = "N"`; Bitrix24 does not notify them. No `notifyAdd` is sent for them.
- **Channels** (`chat.type: "channel"`) send ordinary `messageChat` events. The public `im.chat.add` ignores a channel type; channels are created with the portal's internal `im.v2.Chat.add` action (`fields.type: "CHANNEL"`).
- **Muted chats** still get `params.notify: true`; the mute is only in `chat.mute_list[<your id>]`. A mention in a muted chat additionally sends `addAnchor` with `type: "mention"`.

## Opening things in an existing portal tab

The portal page exposes `BX.Messenger.Public.openChat(dialogId)` and `BX.Messenger.Public.openNotifications()`. Without an open tab, the extension opens `https://<portal>/online/?IM_DIALOG=<dialogId>`.
