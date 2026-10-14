// Offscreen document: holds one Push&Pull WebSocket per portal. They would not
// survive in the service worker (it is suspended after ~30 s without extension
// events, and the pull server sends no keepalive traffic). Events are relayed to
// the worker, tagged with the portal origin.

import { PullClient } from '../src/lib/pull.js';

const send = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

const clients = new Map();

function clientFor(origin) {
  if (!clients.has(origin)) {
    clients.set(
      origin,
      new PullClient({
        onEvents: (events) => send({ cmd: 'pull-events', origin, events }),
        onState: (state, detail) => send({ cmd: 'pull-state', origin, state, detail }),
        onNeedConfig: (reason) => send({ cmd: 'pull-need-config', origin, reason }),
      }),
    );
  }
  return clients.get(origin);
}

const info = () => Object.fromEntries([...clients].map(([origin, c]) => [origin, c.info()]));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'start':
      clientFor(msg.origin).start(msg.config);
      break;
    case 'stop':
      clients.get(msg.origin)?.stop();
      clients.delete(msg.origin);
      break;
    case 'poke':
      for (const c of clients.values()) c.poke();
      break;
    case 'info':
      break;
    default:
      return;
  }
  reply(info());
});

addEventListener('online', () => {
  for (const c of clients.values()) c.poke();
});
