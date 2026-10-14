import { localize, t, STATE_UI } from '../ui/i18n.js';
import { setSettings } from '../lib/settings.js';
import { displayState } from '../lib/status.js';

const $ = (id) => document.getElementById(id);

const ask = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: 'background', cmd, ...extra });

function renderPortal(p) {
  const li = $('row').content.firstElementChild.cloneNode(true);
  const d = displayState(p);
  const [dot, label] = STATE_UI[d] || STATE_UI.error;
  li.querySelector('.dot').className = `dot ${dot}`;
  li.querySelector('.host').textContent = new URL(p.origin).host;
  li.querySelector('.state').textContent = [t(label), d === 'online' || d === 'polling' ? p.me?.name : ''].filter(Boolean).join(' · ');
  const unread = li.querySelector('.unread');
  unread.hidden = !(p.auth === 'ok' && p.total > 0);
  unread.textContent = p.total > 99 ? '99+' : String(p.total);
  const open = li.querySelector('.open');
  open.textContent = t(d === 'login' ? 'popupLogin' : 'popupOpenShort');
  open.hidden = d === 'permission';
  open.onclick = () => {
    ask('open-portal', { origin: p.origin });
    window.close();
  };
  return li;
}

function render({ settings, portals }) {
  $('portals').replaceChildren(...portals.map(renderPortal));
  const none = !portals.length;
  $('empty').hidden = !none;
  $('setup').hidden = !none && !portals.some((p) => p.auth === 'permission');
  $('mute').hidden = none;
  const muted = settings.muteUntil > Date.now();
  $('mute').textContent = t(muted ? 'popupUnmute' : 'popupMute');
  $('mute').dataset.muted = muted ? '1' : '';
  $('muted').hidden = !muted;
  if (muted) {
    const time = new Date(settings.muteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('muted').textContent = t('popupMutedUntil', [time]);
  }
}

localize();
render(await ask('get-state'));
// Re-check the sessions in the background (e.g. the user has just logged in).
ask('refresh').then(render);

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
