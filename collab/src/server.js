import { Server } from '@hocuspocus/server';
import { onAuthenticate } from './authenticate.js';
import { onLoadDocument, onStoreDocument } from './persistence.js';

// Builds the server without listening, so tests can start it on a random port.
export function createServer(options = {}) {
  return new Server({
    onAuthenticate,
    onLoadDocument,
    onStoreDocument,
    // Store 2 s after typing pauses, and at least every 10 s while it doesn't.
    debounce: 2000,
    maxDebounce: 10000,
    ...options,
  });
}
