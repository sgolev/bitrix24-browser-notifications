# Bitrix24 Notifications — notes for Claude

Browser extension (Chromium + Firefox, MV3) that shows desktop notifications for Bitrix24 chat messages (muted chats only for mentions), reactions to the user's chat messages, audio/video calls (incoming and missed) and bell notifications (tasks, feed, calendar, …), for several portals at once. Task comments and telephony are not notified. The README's feature list is the verified reference. It uses the user's browser login (cookies + `sessid`), not OAuth or webhooks. Plain JS ES modules, no npm and no dependencies.

## Layout and build
- `src/` is shared code and becomes the root of each built extension. `platforms/<browser>/manifest.json` holds the per-browser manifests. `tests/` is copied into dev builds only.
- `python3 scripts/build.py [chromium|firefox|all] [--package]` builds `build/<browser>/` (loadable) and, with `--package`, `dist/*.zip`. Never edit `build/`.
- Keep `version` equal in both manifests; the build fails otherwise. The Firefox add-on ID `bitrix24-notifications@sgolev` must never change.
- Browser differences live only in `src/lib/pull-host.js` (where sockets live) and `src/lib/platform.js` (notification options). Everything else is shared. Feature-detect; don't fork files.

## Architecture essentials
- `src/background.js` orchestrates per portal. Each portal has its own work queue (`enqueueFor(origin, fn)`, `lib/serial.js`), so a slow portal never delays the others; never await a portal's own queue from inside it. Shared state has short locks: the notification registry (`lib/notifier.js`) and the badge. UI pages read state from storage (`lib/state.js`), never through a queue.
  - **State keys:** session `portal:<origin>` and `sessid:<origin>`; local `cursor:<origin>`.
  - **Notification ids:** `<origin>|<kind>:<id>`.
- Push&Pull WebSockets run in text mode, parsed in `lib/pull.js`.
  - **Chromium:** they live in an offscreen document, because the service worker dies after ~30 s and the server sends no keepalive frames.
  - **Firefox:** they live in the background event page, kept awake by `runtime.getPlatformInfo()` every 20 s.
  - The 1-minute `tick` alarm reconnects and catches up through REST (`lib/poller.js`) whenever sockets are gone.
- `lib/events.js` maps pull commands to notification actions. `docs/protocol.md` records the real payloads and REST behaviour. To find out what Bitrix24 sends for an action, sniff the pull channel (testing guide in `CLAUDE.local.md`, if present) instead of guessing. These are undocumented internal Bitrix24 APIs, so update that file when a payload changes.
- Firefox notifications accept only `type/title/message/iconUrl`. Any other key throws, so always go through `notifier.show()`.

## Gotchas
- Every UI string goes in both `src/_locales/en` and `src/_locales/ru`.
- `permissions.request` must run synchronously inside the user gesture (see `options.js`).
- Extension pages use relative paths inside the build root (`../lib/…`, `../ui/…`, `../icons/…`).
- The notification registry lives in session storage and is wiped on reload. `notifier.lookup`/`clearWhere` rebuild entries from displayed ids, so don't rely on the registry alone.

## Testing
- **Unit tests:** open `tests/tests.html` in the built extension. The page title shows `PASS n` / `FAIL n`. Add tests for pure logic there.
- **E2E:** use the two demo portals and accounts (ask the user for credentials; never commit them). Drive Chromium over CDP (Playwright `connect_over_cdp`) and Firefox over WebDriver BiDi (launch with `-remote-allow-system-access`). In the background console, `b24n.tick()`, `b24n.catchUp(origin)`, `b24n.click(id)` and `b24n.button(id)` simulate actions.
- Native permission prompts can't be automated. Pre-grant portal origins in a test copy's manifest, and ask the user to check the real prompt.

## Conventions
- Commits end with the Co-Authored-By line. Never commit `*.pem`/`*.crx` or credential files.
- Match the existing style: short "why" comments, no build tooling beyond `scripts/build.py`.
