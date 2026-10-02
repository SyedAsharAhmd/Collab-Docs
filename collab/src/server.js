import { Server } from '@hocuspocus/server';
import { onAuthenticate } from './authenticate.js';
import { onLoadDocument, onStoreDocument } from './persistence.js';
import { listenForAccessChanges } from './accessListener.js';

// Largest single WebSocket message the server accepts. The ws library's default is
// 100 MB, which would let one malicious client exhaust the server's memory. 10 MB is
// millions of characters: far above any real paste, and above a whole large document,
// which a reconnecting client sends in one message. Bigger messages close the
// connection with code 1009 (Message Too Big) before they are processed.
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

// Builds the server without listening, so tests can start it on a random port.
export function createServer(options = {}) {
  let stopListening = null;

  return new Server({
    onAuthenticate,
    onLoadDocument,
    onStoreDocument,
    // Store 2 s after typing pauses, and at least every 10 s while it doesn't.
    debounce: 2000,
    maxDebounce: 10000,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },
    // Start reacting to permission changes once the server is up; stop on shutdown.
    async onListen({ instance }) {
      stopListening = await listenForAccessChanges(instance);
    },
    async onDestroy() {
      await stopListening?.();
    },
    ...options,
  });
}
