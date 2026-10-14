// Offscreen document (Chromium only): holds one Push&Pull WebSocket per portal,
// because the service worker cannot keep a socket alive. Events are relayed to
// the worker, tagged with the portal origin. See ../lib/pull-host.js.

import { createLocalHost } from '../lib/pull-host.js';

const host = createLocalHost();
host.onMessage((msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {}));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  const commands = {
    start: () => host.start(msg.origin, msg.config),
    stop: () => host.stop(msg.origin),
    poke: () => host.poke(),
    info: () => host.info(),
  };
  if (!commands[msg.cmd]) return;
  commands[msg.cmd]().then(reply);
  return true;
});
