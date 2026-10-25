// Per-portal connection state in storage.session: "portal:<origin>" =
// { auth, pull, total, error, me, lastPollAt }. Written only by the background;
// the popup and options pages read it directly, so they never wait behind the
// background's work queue (a slow portal can keep that busy for a long time).

import { DEFAULT_STATE } from './status.js';

export const stateKey = (origin) => `portal:${origin}`;

export async function getState(origin) {
  const key = stateKey(origin);
  return { ...DEFAULT_STATE, ...(await chrome.storage.session.get(key))[key] };
}

export async function getAllStates(portals) {
  const stored = await chrome.storage.session.get(portals.map(stateKey));
  return portals.map((origin) => ({ origin, ...DEFAULT_STATE, ...stored[stateKey(origin)] }));
}

// True if a storage change can affect what the popup/options pages show.
export const affectsUi = (changes, area) => area === 'sync' || Object.keys(changes).some((k) => k.startsWith('portal:'));
