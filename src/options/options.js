import { localize, t, STATE_UI } from '../ui/i18n.js';
import { getSettings, setSettings, addPortal, originPattern } from '../lib/settings.js';
import { displayState } from '../lib/status.js';
import { getAllStates, affectsUi } from '../lib/state.js';

const $ = (id) => document.getElementById(id);
const ask = (cmd, extra = {}) => chrome.runtime.sendMessage({ target: 'background', cmd, ...extra });

function message(text, isError = false) {
  $('portal-msg').textContent = text;
  $('portal-msg').className = `small${isError ? ' error' : ''}`;
}

function renderPortal(p) {
  const li = $('row').content.firstElementChild.cloneNode(true);
  localize(li);
  const d = displayState(p);
  const [dot, label] = STATE_UI[d] || STATE_UI.error;
  li.querySelector('.dot').className = `dot ${dot}`;
  li.querySelector('.host').textContent = new URL(p.origin).host;
  li.querySelector('.state').textContent = t(label) + (p.error ? ` (${p.error})` : '');
  li.querySelector('.remove').onclick = async () => {
    const { portals } = await getSettings();
    await setSettings({ portals: portals.filter((o) => o !== p.origin) });
    chrome.permissions.remove({ origins: [originPattern(p.origin)] }).catch(() => {});
  };
  return li;
}

let shown = []; // origins currently listed

// Reads state straight from storage, like the popup, so a slow portal can't stall the page.
async function render() {
  const portals = await getAllStates((await getSettings()).portals);
  shown = portals.map((p) => p.origin);
  $('portals').replaceChildren(...portals.map(renderPortal));
  $('welcome').hidden = portals.length > 0;
  if (!portals.length) $('portal').focus();
}

localize();
const settings = await getSettings();
for (const box of document.querySelectorAll('input[data-key]')) {
  box.checked = !!settings[box.dataset.key];
  box.onchange = () => setSettings({ [box.dataset.key]: box.checked });
}

$('portal-form').onsubmit = (e) => {
  e.preventDefault();
  // Validate synchronously against the list rendered on the page, so the permission
  // request below still runs inside the user gesture.
  const { origin, error } = addPortal(shown, $('portal').value);
  if (error === 'invalid') return message(t('optInvalidUrl'), true);
  if (error === 'duplicate') return message(t('optDuplicate'), true);
  chrome.permissions.request({ origins: [originPattern(origin)] }).then(async (granted) => {
    if (!granted) return message(t('optPermissionDenied'), true);
    const latest = await getSettings();
    const res = addPortal(latest.portals, origin);
    if (!res.error) await setSettings({ portals: res.portals });
    $('portal').value = '';
    message(t('optSaved'));
  });
};

$('test').onclick = () => ask('test-notification');

chrome.storage.onChanged.addListener((changes, area) => {
  if (affectsUi(changes, area)) render();
});
render();
