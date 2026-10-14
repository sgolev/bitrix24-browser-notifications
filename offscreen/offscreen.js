// Offscreen document: holds the Push&Pull WebSocket, which would not survive in
// the service worker (it is suspended after ~30 s without extension events, and
// the pull server sends no keepalive traffic). Events are relayed to the worker.

import { PullClient } from '../src/lib/pull.js';

const send = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

const client = new PullClient({
  onEvents: (events) => send({ cmd: 'pull-events', events }),
  onState: (state, detail) => send({ cmd: 'pull-state', state, detail }),
  onNeedConfig: (reason) => send({ cmd: 'pull-need-config', reason }),
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.cmd) {
    case 'start':
      client.start(msg.config);
      break;
    case 'stop':
      client.stop();
      break;
    case 'poke':
      client.poke();
      break;
    case 'info':
      break;
    default:
      return;
  }
  reply(client.info());
});

addEventListener('online', () => client.poke());
