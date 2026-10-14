// Browser differences that cannot be feature-detected at the call site.

export const isFirefox = chrome.runtime.getURL('').startsWith('moz-extension:');

// Firefox notifications accept only type/title/message/iconUrl and reject any other
// key. The context line (portal host) moves into the message; buttons,
// requireInteraction, silent and priority are dropped.
export function toFirefoxOptions(opts) {
  const out = {};
  for (const key of ['type', 'title', 'message', 'iconUrl']) {
    if (opts[key] !== undefined) out[key] = opts[key];
  }
  if (opts.contextMessage) out.message = out.message ? `${out.message}\n${opts.contextMessage}` : opts.contextMessage;
  return out;
}

export const notificationOptions = isFirefox ? toFirefoxOptions : (opts) => opts;
