// Session-authenticated access to the portal REST API: uses the browser's login
// cookies plus the CSRF token (sessid), which the portal hands back on a
// "session_failed" response. See docs/protocol.md.

export class AuthError extends Error {
  constructor(message = 'Not logged in') {
    super(message);
    this.name = 'AuthError';
  }
}

export class RestError extends Error {
  constructor(code, description, status) {
    super(`${code}: ${description || ''}`);
    this.name = 'RestError';
    Object.assign(this, { code, status });
  }
}

// Background requests give up sooner, so a portal that doesn't respond is reported
// ("not responding") and retried by the next tick instead of holding its queue.
// Requests the user is waiting for (e.g. "Mark as read") get longer.
export const BACKGROUND_TIMEOUT_MS = 10000;
export const INTERACTIVE_TIMEOUT_MS = 20000;

const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

// Each portal has its own sessid, kept in storage.session under "sessid:<origin>".
export const sessidKey = (origin) => `sessid:${origin}`;

// Throws AuthError (not logged in) or RestError; RestError code "TIMEOUT" means the
// portal did not answer in time, "NETWORK" that it could not be reached at all.
export async function callRest(origin, method, params = {}, { timeoutMs = BACKGROUND_TIMEOUT_MS } = {}) {
  const key = sessidKey(origin);
  let sessid = (await chrome.storage.session.get(key))[key] || '';
  const timeout = () => new RestError('TIMEOUT', `no response within ${timeoutMs / 1000} s`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetch(`${origin}/rest/${method}.json?sessid=${encodeURIComponent(sessid || '-')}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
    } catch (e) {
      throw isTimeout(e) ? timeout() : new RestError('NETWORK', String(e.message || e));
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      if (isTimeout(e)) throw timeout();
      // HTML instead of JSON: redirected to a login page.
      if (res.redirected || res.status === 401 || res.status === 403) throw new AuthError();
      throw new RestError('BAD_RESPONSE', `HTTP ${res.status}`, res.status);
    }
    if (data.error === 'session_failed' && data.sessid && data.sessid !== sessid) {
      sessid = data.sessid;
      await chrome.storage.session.set({ [key]: sessid });
      continue;
    }
    if (data.error) {
      // Logged out: 401 with access_denied/user_not_authorized (or NO_AUTH_FOUND).
      if (res.status === 401 || ['NO_AUTH_FOUND', 'session_failed', 'expired_token', 'invalid_token'].includes(data.error)) {
        throw new AuthError(data.error_description || data.error);
      }
      throw new RestError(data.error, data.error_description, res.status);
    }
    return data.result;
  }
  throw new AuthError('sessid rejected');
}

// Fetches an image from the portal and returns a data: URL (notifications cannot
// load authenticated remote images themselves). Returns '' on any failure.
export async function fetchImageDataUrl(url) {
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(5000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return '';
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 512 * 1024) return '';
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type.split(';')[0]};base64,${btoa(bin)}`;
  } catch {
    return '';
  }
}
