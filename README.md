# Bitrix24 Notifications (Chromium and Firefox extension)

Native desktop notifications for Bitrix24 that work even when no portal tab is open:

- **Chat messages** (private and group). One notification per dialog, updated with an unread count. A **Mark as read** button (Chromium).
- **Bell notifications** (tasks, mentions, comments, …). Clicking one opens its link. A **Mark as read** button (Chromium).
- **Incoming calls**. On Chromium the notification stays on screen while the call rings. It is replaced by a **missed call** notification if nobody answers.
- Notifications disappear when you read the message or answer the call somewhere else (portal tab, mobile app, desktop app).
- The toolbar badge shows the unread count. `!` means you need to log in, `?` means the extension is not set up yet.
- Clicking a chat notification opens that chat. If a portal tab is already open, it is reused without a reload.
- **Several portals at once.** Each portal has its own connection and login state. When more than one portal is configured, every notification names its portal. The badge adds up unread counts across portals.
- Settings: notification types, hiding message text, silent mode, mute for 1 hour, and no notifications while a portal tab is focused. These are shared by all portals. English and Russian UI.

There is no separate login. The extension uses your normal portal session in the same browser, the same way the portal page does.

The Chromium (Chrome, Edge, Yandex Browser, Brave, …) and Firefox versions are built from the same source. See [Firefox differences](#firefox-differences).

## Build

Python 3 is the only requirement (no npm).

```sh
python3 scripts/build.py              # build/chromium/ and build/firefox/ (loadable, with unit tests)
python3 scripts/build.py firefox      # one browser only
python3 scripts/build.py --package    # also dist/bitrix24-notifications-<browser>-<version>.zip for the stores
```

In VS Code, **Run Build Task** builds both browsers. **Tasks: Run Task → Package for stores** writes the ZIPs.

## Install

### Chromium

1. Run the build, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `build/chromium`. After rebuilding, press **Reload** on the extension card.

### Firefox (128 or newer)

1. Run the build, then open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `build/firefox/manifest.json`. A temporary add-on stays until Firefox restarts.

Firefox only installs signed add-ons permanently. Upload `dist/bitrix24-notifications-firefox-<version>.zip` to [addons.mozilla.org](https://addons.mozilla.org/developers/) to sign it, either listed or for self-distribution. Firefox Developer Edition and Nightly can also install unsigned builds when `xpinstall.signatures.required` is `false` in `about:config`.

### Setup (both browsers)

1. The settings page opens automatically after installing. You can also open it later from the extension menu (**Options** / **Settings**).
2. Enter your portal address (e.g. `https://yourcompany.bitrix24.ru`), click **Add portal**, then allow access to that site when the browser asks. Repeat for any other portals.
3. Log in to each portal in this browser if you have not already. The badge turns into an unread counter, and the popup lists each portal as **Connected, real-time**.

## Firefox differences

Firefox notifications support only a title, a text and an icon. Compared with Chromium:

- There are no **Mark as read** or **Answer** buttons. Clicking a notification opens the chat, notification or call, as on Chromium.
- Call notifications don't stay on screen while the call rings. They are still removed when the call ends, and a missed call is still reported.
- The portal name, shown under the text on Chromium, is the last line of the text.
- **Silent notifications** is up to your desktop's notification settings.

## Repository layout

```
src/                     shared extension code (the root of each built extension)
  background.js          background: session, events → notifications, badge, clicks, polling
  lib/                   protocol, formatting, notifications, settings (see below)
  offscreen/             Chromium only: page that hosts the WebSockets
  popup/  options/  ui/  _locales/  icons/
platforms/chromium/manifest.json
platforms/firefox/manifest.json
tests/                   unit tests (included in build/, not in the store ZIPs)
scripts/build.py         assembles build/<browser>/ and dist/*.zip
docs/protocol.md         the Bitrix24 APIs and events the extension relies on
```

## How it works

```
pull host (lib/pull-host.js)   one Push&Pull WebSocket per portal (lib/pull.js)
  Chromium: offscreen document  ─ runtime messages ─┐
  Firefox:  the background page itself ─────────────┤
                                                    ▼
background.js                  session, events → notifications, badge, clicks,
                               1-minute watchdog alarm, REST catch-up polling
        │ fetch with cookies + sessid
https://<portal>/rest/…        im.user.get, pull.config.get, im.counters.get, im.recent.list, …
```

- **Session.** REST calls go to `https://<portal>/rest/<method>.json` with the browser's cookies. The CSRF token (`sessid`) is learned from the portal's own `session_failed` reply. See `src/lib/portal.js`.
- **Real time.** `pull.config.get` returns the Push&Pull server and channels. The pull host keeps one WebSocket per portal open in text mode. It handles channel expiry and reconnects with backoff, replaying missed messages by `mid`.
  - **Chromium:** the WebSockets live in an offscreen document, because Chromium suspends an idle service worker after about 30 s and the pull server sends no keepalive traffic.
  - **Firefox:** there are no offscreen documents, so the sockets live in the background event page. A light API call every 20 s keeps the page awake while sockets are open.
- **Fallback.** The watchdog alarm runs every minute. If a real-time connection is down (or the background was restarted), it reconnects and polls `im.recent.list` and `im.notify.get`. It also polls every 5 minutes as a safety net. Each dialog's last-seen message id is stored, so nothing is notified twice. After a long absence, more than 3 pending items are folded into one summary notification. Items older than 12 h are not notified.
- **Event mapping.** `src/lib/events.js` turns pull commands into notification actions. `docs/protocol.md` documents the payloads this relies on.
- **Per-portal state.** Session storage keeps `portal:<origin>` (login, connection, unread count) and `sessid:<origin>`. Local storage keeps `cursor:<origin>` (last-notified ids). Notification ids are `<origin>|<kind>:<id>`. Removing a portal drops all of these.
- **Browser differences** are feature-detected in `src/lib/pull-host.js` (where the sockets live) and `src/lib/platform.js` (notification options). Everything else is shared.

### Permissions

| Permission | Why |
| --- | --- |
| `notifications` | Show desktop notifications. |
| `alarms` | One-minute watchdog. |
| `storage` | Settings, and per-dialog "last notified" ids. |
| `offscreen` (Chromium only) | A hidden page that keeps the WebSockets open. |
| `scripting` | Opens a chat inside an already-open portal tab instead of reloading it. |
| Access to your portals (requested when adding each one) | REST calls with your session. Also lets the extension see whether a portal tab is open or focused. |

The extension has no access to any other site. Removing a portal also gives up access to it.

## Limitations

- It relies on the portal's internal web APIs and the Push&Pull protocol, as observed on Bitrix24 cloud in October 2026. These are not public, documented APIs, and Bitrix24 updates could change them. `docs/protocol.md` lists exactly what is used.
- It has only been tested with Bitrix24 cloud. Self-hosted ("box") installations may use a different pull server version.
- Calls cannot be answered from the notification. **Answer** (Chromium) or a click opens the chat, and you answer in the portal.

## Development

- Edit files under `src/`, `platforms/` or `tests/`, run `python3 scripts/build.py`, then reload the extension in the browser.
- Keep the `version` in both manifests the same. The build refuses to run otherwise.
- **Unit tests.** Open `tests/tests.html` inside the built extension (`chrome-extension://<id>/tests/tests.html` or `moz-extension://<uuid>/tests/tests.html`). The page and its title show `PASS n` or `FAIL n`. They cover the formatter, event mapping, the pull client (with a fake socket), the polling converters, the settings and badge helpers, and the Firefox notification options.
- **Debugging.** In the background's DevTools console, `b24n.tick()`, `b24n.catchUp('<origin>')`, `b24n.click('<notification id>')` and `b24n.button('<id>')` run the corresponding logic. Chromium: *service worker* link on the extension card. Firefox: **Inspect** in `about:debugging`.
