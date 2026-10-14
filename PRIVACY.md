# Privacy Policy — Bitrix24 Notifications

Last updated: October 14, 2026

Bitrix24 Notifications ("the extension") shows desktop notifications for Bitrix24 chat messages, notifications and calls. This policy explains what data the extension handles and how.

## Summary

The extension does not send any data to its developer or to any third party. It has no analytics, tracking or advertising. It exchanges data only with the Bitrix24 portals that you add in its settings.

## Data the extension handles

To show notifications, the extension reads the following from the Bitrix24 portals you added, using your existing login session in the browser:

- **Messages and notifications:** sender names, avatars, message text, notification text and links, unread counts.
- **Call information:** the caller's name and whether a call is ringing, answered or missed.
- **Your Bitrix24 user ID and name**, used to tell your own messages apart from others' messages.
- **Session data:** the browser sends your Bitrix24 login cookies with the extension's requests to your portal, the same way it does when you open the portal page. The extension also keeps the portal's security token (`sessid`) in memory so it can make these requests. The extension never sees or stores your password.

This data is used only to show, update and clear notifications, and to display the unread counter. Message content is not stored. It is shown in a notification and then discarded.

## Data stored on your device

- **Settings** (portal addresses and notification preferences) are stored with `chrome.storage.sync`. If you have Chrome sync turned on, your browser syncs them to your other devices through your Google account.
- **For each chat, the ID of the last message already notified** is stored with `chrome.storage.local`, so you are never notified twice about the same message.
- **Connection status, unread counts and the session token** are kept in `chrome.storage.session`, which is cleared when the browser closes.

Removing a portal in the settings deletes all data stored for it and gives up the extension's access to that site. Uninstalling the extension deletes all of its data.

## Where data is sent

The extension connects only to:

- the Bitrix24 portals you added, and
- the real-time (Push&Pull) server and image servers that those portals point it to, all of which are part of the Bitrix24 service.

Your use of Bitrix24 itself is covered by the Bitrix24 privacy policy and your company's agreement with Bitrix24.

## Selling and sharing data

The extension does not sell, transfer or share user data with anyone. It does not use or transfer user data for purposes unrelated to its single purpose, and it does not use user data to determine creditworthiness or for lending purposes.

The use of information received from Chrome APIs complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/), including the Limited Use requirements.

## Changes

If this policy changes, the updated version will be published at this address with a new "Last updated" date.

## Contact

Questions about this policy: sgolev262@gmail.com
