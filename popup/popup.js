import { localize, t } from '../src/ui/i18n.js';
import { setSettings } from '../src/lib/settings.js';

const $ = (id) => document.getElementById(id);

const STATES = {
  online: ['ok', 'popupStateOnline'],
  polling: ['off', 'popupStatePolling'],
  login: ['warn', 'popupStateLogin'],
  unconfigured: ['off', 'popupStateUnconfigured'],
  permission: ['warn', 'popupStatePermission'],
  error: ['warn', 'popupStateError'],
};

function render({ status, me, settings }) {
  const auth = status.auth;
  const key = auth === 'ok' ? (status.pull === 'online' ? 'online' : 'polling') : auth;
  const [dot, label] = STATES[key] || STATES.error;
  $('dot').className = `dot ${dot}`;
  $('state').textContent = t(label);
  $('portal').textContent = settings.portalUrl ? new URL(settings.portalUrl).host : '';

  const ok = auth === 'ok';
  $('info').hidden = !ok;
  $('open').hidden = !settings.portalUrl || auth === 'login';
  $('login').hidden = auth !== 'login';
  $('setup').hidden = !(auth === 'unconfigured' || auth === 'permission');
  $('mute').hidden = !ok;
  if (ok) {
    $('user').textContent = me?.name || '';
    $('unread').textContent = String(status.total || 0);
    const muted = settings.muteUntil > Date.now();
    $('mute').textContent = t(muted ? 'popupUnmute' : 'popupMute');
    $('mute').dataset.muted = muted ? '1' : '';
    $('muted').hidden = !muted;
    if (muted) {
      const time = new Date(settings.muteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('muted').textContent = t('popupMutedUntil', [time]);
    }
  }
}

const ask = (cmd) => chrome.runtime.sendMessage({ target: 'background', cmd });

localize();
render(await ask('get-state'));
// Re-check the session in the background (e.g. the user has just logged in).
ask('refresh').then(render);

$('open').onclick = () => {
  ask('open-portal');
  window.close();
};
$('login').onclick = $('open').onclick;
$('setup').onclick = () => chrome.runtime.openOptionsPage();
$('settings').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};
$('mute').onclick = async () => {
  const muteUntil = $('mute').dataset.muted ? 0 : Date.now() + 60 * 60 * 1000;
  await setSettings({ muteUntil });
  render(await ask('get-state'));
};
