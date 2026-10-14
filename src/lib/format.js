// Turns Bitrix24 message/notification markup (BBCode mixed with legacy HTML) into
// plain text suitable for a desktop notification.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Tags whose markers are dropped but whose inner text is kept.
const INLINE_TAGS = 'b|i|u|s|color|size|font|left|right|center|justify|list|\\*|p|code|context|send|put|call|user|chat|url|dialog|timestamp|spoiler|lines';

export function toPlainText(input, { fileLabel = '[File]' } = {}) {
  if (input == null) return '';
  let s = String(input);

  // Quoted replies: "-----…\nAuthor [date]\nquoted text\n-----…" (54 dashes) and [QUOTE]…[/QUOTE].
  s = s.replace(/-{54}[\s\S]*?-{54}\s*/g, '');
  s = s.replace(/\[quote\][\s\S]*?\[\/quote\]\s*/gi, '');

  // Legacy HTML.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');

  s = s.replace(/\[br\]/gi, '\n');
  s = s.replace(/\[disk=[^\]]*\]/gi, fileLabel);
  s = s.replace(/\[(?:icon|attach|img)[^\]]*\](?:[^[]*\[\/img\])?/gi, '');
  s = s.replace(new RegExp(`\\[\\/?(?:${INLINE_TAGS})(?:[= ][^\\]]*)?\\]`, 'gi'), '');

  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n');
  return s.trim();
}

export function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  return s.slice(0, max - 1).trimEnd() + '…';
}

// First [URL=…] target found in BBCode, or href in HTML.
export function extractUrl(s) {
  if (!s) return '';
  const m = /\[url=([^\]]+)\]/i.exec(s) || /href=["']([^"']+)["']/i.exec(s);
  return m ? decodeEntities(m[1].trim()) : '';
}

export function userName(user) {
  if (!user) return '';
  return user.name || [user.first_name ?? user.firstName, user.last_name ?? user.lastName].filter(Boolean).join(' ');
}

// Makes a portal-relative path absolute; drops Bitrix's placeholder images.
export function absoluteUrl(url, origin) {
  if (!url || /\/blank\.gif$/.test(url)) return '';
  try {
    return new URL(url, origin).href;
  } catch {
    return '';
  }
}
