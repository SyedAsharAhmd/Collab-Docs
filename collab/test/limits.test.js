import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { MAX_MESSAGE_BYTES } from '../src/server.js';
import { applySchema, connect, createDocument, createUser, destroyProviders, startServer, tokenFor, waitFor } from './helpers.js';

let server, url, owner, docId;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  owner = await createUser('owner');
  docId = await createDocument(owner);
  ({ server, url } = await startServer());
});

afterEach(async () => {
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

// A raw WebSocket, like an attacker's script: no provider, no auth, just bytes.
function rawSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve(socket);
    socket.onerror = reject;
  });
}

const closed = (socket) => new Promise((resolve) => (socket.onclose = (event) => resolve(event.code)));

it('closes a connection that sends a message over the size limit, with code 1009', async () => {
  const socket = await rawSocket();
  const closing = closed(socket);
  socket.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
  expect(await closing).toBe(1009); // Message Too Big
});

it('applies the limit to logged-in editors too, and leaves the document unchanged', async () => {
  const editor = await connect(url, docId, tokenFor(owner));
  const watcher = await connect(url, docId, tokenFor(owner));
  editor.ydoc.getText('t').insert(0, 'before');
  await waitFor(() => watcher.ydoc.getText('t').toString() === 'before');

  // A real, valid Yjs edit that is simply too big: the provider sends it as one update.
  // (Junk bytes would be rejected anyway as malformed; a valid update would not.)
  const socket = editor.provider.configuration.websocketProvider.webSocket;
  const closing = new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  editor.ydoc.getText('t').insert(6, 'x'.repeat(MAX_MESSAGE_BYTES + 1));
  expect(await closing).toBe(1009);
  editor.provider.destroy(); // otherwise it would reconnect and try to resend it

  expect(server.hocuspocus.documents.get(docId).getText('t').toString()).toBe('before');
  expect(watcher.ydoc.getText('t').toString()).toBe('before');
});

it('keeps serving everyone else after rejecting an oversized message', async () => {
  const a = await connect(url, docId, tokenFor(owner));
  const b = await connect(url, docId, tokenFor(owner));

  const attacker = await rawSocket();
  const closing = closed(attacker);
  attacker.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
  await closing;

  a.ydoc.getText('t').insert(0, 'still working');
  await waitFor(() => b.ydoc.getText('t').toString() === 'still working');
});
