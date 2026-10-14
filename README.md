# Bitrix24 Notifications (Chromium extension)

Native desktop notifications for Bitrix24 that work even when no portal tab is open:

- **Chat messages** (private and group). One notification per dialog, updated with an unread count. A **Mark as read** button.
- **Bell notifications** (tasks, mentions, comments, …). Clicking one opens its link. A **Mark as read** button.
- **Incoming calls**. The notification stays on screen while the call rings. It is replaced by a **missed call** notification if nobody answers.
- Notifications disappear when you read the message or answer the call somewhere else (portal tab, mobile app, desktop app).
- The toolbar badge shows the unread count. `!` means you need to log in, `?` means the extension is not set up yet.
- Clicking a chat notification opens that chat. If a portal tab is already open, it is reused without a reload.
- Settings: notification types, hiding message text, silent mode, mute for 1 hour, and no notifications while a portal tab is focused. English and Russian UI.

There is no separate login. The extension uses your normal portal session in the same browser, the same way the portal page does.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
3. The settings page opens automatically after installing. You can also open it later from the extension menu (**Options**). Enter your portal address (e.g. `https://yourcompany.bitrix24.ru`), click **Save**, then allow access to that site when the browser asks.
4. Log in to the portal in this browser if you have not already. The badge turns into an unread counter, and the popup shows **Connected, real-time**.

## How it works

```
offscreen/offscreen.js   holds the Push&Pull WebSocket (src/lib/pull.js), relays events
        │ runtime messages
src/background.js        service worker: session, events → notifications, badge, clicks,
                         1-minute watchdog alarm, REST catch-up polling
        │ fetch with cookies + sessid
https://<portal>/rest/…  im.user.get, pull.config.get, im.counters.get, im.recent.list, …
```

- **Session.** REST calls go to `https://<portal>/rest/<method>.json` with the browser's cookies. The CSRF token (`sessid`) is learned from the portal's own `session_failed` reply. See `src/lib/portal.js`.
- **Real time.** `pull.config.get` returns the Push&Pull server and channels. The offscreen document keeps the WebSocket open in text mode. It handles channel expiry and reconnects with backoff, replaying missed messages by `mid`. The WebSocket can't live in the service worker, because Chromium suspends an idle worker after about 30 s and the pull server sends no keepalive traffic.
- **Fallback.** The watchdog alarm runs every minute. If the real-time connection is down, it polls `im.recent.list` and `im.notify.get`. It also polls every 5 minutes as a safety net. Each dialog's last-seen message id is stored, so nothing is notified twice. After a long absence, more than 3 pending items are folded into one summary notification. Items older than 12 h are not notified.
- **Event mapping.** `src/lib/events.js` turns pull commands into notification actions. `docs/protocol.md` documents the payloads this relies on.

### Permissions

| Permission | Why |
| --- | --- |
| `notifications` | Show desktop notifications. |
| `alarms` | One-minute watchdog. |
| `storage` | Settings, and per-dialog "last notified" ids. |
| `offscreen` | A hidden page that keeps the WebSocket open. |
| `scripting` | Opens a chat inside an already-open portal tab instead of reloading it. |
| Access to your portal (requested at setup) | REST calls with your session. Also lets the extension see whether a portal tab is open or focused. |

The extension has no access to any other site.

## Limitations

- It relies on the portal's internal web APIs and the Push&Pull protocol, as observed on Bitrix24 cloud in October 2026. These are not public, documented APIs, and Bitrix24 updates could change them. `docs/protocol.md` lists exactly what is used.
- It has only been tested with Bitrix24 cloud. Self-hosted ("box") installations may use a different pull server version.
- One portal at a time.
- Calls cannot be answered from the notification. **Answer** opens the chat, and you answer in the portal.

## Development

- No build step and no dependencies. Edit the files, then press **Reload** on `chrome://extensions`.
- **Unit tests.** Open `chrome-extension://<extension id>/tests/tests.html`. The page and its title show `PASS n` or `FAIL n`. They cover the formatter, event mapping, the pull client (with a fake socket) and the polling converters.
- **Debugging.** In the service worker's DevTools console, `b24n.tick()`, `b24n.catchUp()`, `b24n.click('<notification id>')` and `b24n.button('<id>')` run the corresponding logic.
