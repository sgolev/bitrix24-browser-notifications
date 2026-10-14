// Fills elements marked with data-i18n / data-i18n-placeholder from _locales.

export const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

export function localize(root = document) {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

// displayState() (src/lib/status.js) → [dot class, message key].
export const STATE_UI = {
  online: ['ok', 'popupStateOnline'],
  polling: ['off', 'popupStatePolling'],
  connecting: ['off', 'popupStateConnecting'],
  login: ['warn', 'popupStateLogin'],
  permission: ['warn', 'popupStatePermission'],
  error: ['warn', 'popupStateError'],
};
