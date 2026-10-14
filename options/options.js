import { localize, t } from '../src/ui/i18n.js';
import { DEFAULTS, getSettings, setSettings, normalizePortalUrl, originPattern } from '../src/lib/settings.js';

const $ = (id) => document.getElementById(id);

const STATES = {
  online: ['ok', 'popupStateOnline'],
  polling: ['off', 'popupStatePolling'],
  login: ['warn', 'popupStateLogin'],
  unconfigured: ['off', 'popupStateUnconfigured'],
  permission: ['warn', 'popupStatePermission'],
  error: ['warn', 'popupStateError'],
};

function message(text, isError = false) {
  $('portal-msg').textContent = text;
  $('portal-msg').className = `small${isError ? ' error' : ''}`;
}

async function renderStatus() {
  const { status } = await chrome.runtime.sendMessage({ target: 'background', cmd: 'get-state' });
  const key = status.auth === 'ok' ? (status.pull === 'online' ? 'online' : 'polling') : status.auth;
  const [dot, label] = STATES[key] || STATES.error;
  $('dot').className = `dot ${dot}`;
  $('state').textContent = t(label) + (status.error ? ` (${status.error})` : '');
}

localize();
const settings = await getSettings();
$('portal').value = settings.portalUrl;
for (const box of document.querySelectorAll('input[data-key]')) {
  box.checked = !!settings[box.dataset.key];
  box.onchange = () => setSettings({ [box.dataset.key]: box.checked });
}

$('portal-form').onsubmit = (e) => {
  e.preventDefault();
  const origin = normalizePortalUrl($('portal').value);
  if (!origin) return message(t('optInvalidUrl'), true);
  $('portal').value = origin;
  // Must be requested straight from the user gesture.
  chrome.permissions.request({ origins: [originPattern(origin)] }).then(async (granted) => {
    if (!granted) return message(t('optPermissionDenied'), true);
    await setSettings({ portalUrl: origin, muteUntil: DEFAULTS.muteUntil });
    message(t('optSaved'));
    // Same URL saved again does not fire storage.onChanged; reconnect explicitly.
    chrome.runtime.sendMessage({ target: 'background', cmd: 'refresh' });
  });
};

$('test').onclick = () => chrome.runtime.sendMessage({ target: 'background', cmd: 'test-notification' });

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session' || area === 'sync') renderStatus();
});
renderStatus();
