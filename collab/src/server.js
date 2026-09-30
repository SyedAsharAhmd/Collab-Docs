import { Server } from '@hocuspocus/server';
import { onAuthenticate } from './authenticate.js';

// Builds the server without listening, so tests can start it on a random port.
// Until M4 adds the load and store hooks, documents live only in memory.
export function createServer(options = {}) {
  return new Server({
    onAuthenticate,
    ...options,
  });
}
