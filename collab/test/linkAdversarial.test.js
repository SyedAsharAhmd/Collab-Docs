import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encoding } from 'lib0';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { pool } from '../src/db.js';
import { MAX_MESSAGE_BYTES } from '../src/server.js';
import {
  applySchema,
  connect,
  createDocument,
  createUser,
  destroyProviders,
  grant,
  openProviders,
  startServer,
  tokenFor,
  waitFor,
} from './helpers.js';

// Hostile and awkward situations around link sharing.

let server, url, owner, editor, stranger, publicDoc, privateDoc;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  owner = await createUser('owner');
  editor = await createUser('editor');
  stranger = await createUser('stranger');
  publicDoc = await createDocument(owner);
  privateDoc = await createDocument(owner);
  await grant(publicDoc, editor, 'editor');
  await pool.query("UPDATE documents SET link_access = 'editor' WHERE id = $1", [publicDoc]);
  ({ server, url } = await startServer());
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MAX_LINK_VIEWERS;
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

const loaded = (docId) => server.hocuspocus.documents.has(docId);
const storedState = async (docId) => (await pool.query('SELECT ydoc_state FROM documents WHERE id = $1', [docId])).rows[0].ydoc_state;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anonymous = (docId = publicDoc) => connect(url, docId, '');

// ---- A visitor on a public document must not reach a private one ----

// Two providers sharing ONE WebSocket, as a browser can: a visitor authenticated for the
// public document tries to open a private one on the same connection.
function sharedSocketProviders(publicToken, privateToken) {
  const socket = new HocuspocusProviderWebsocket({ url });
  const make = (name, token) => {
    const ydoc = new Y.Doc();
    const result = { ydoc, authenticated: false, failed: null };
    result.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: ydoc,
      token,
      onAuthenticated: () => (result.authenticated = true),
      onAuthenticationFailed: ({ reason }) => (result.failed = reason),
    });
    result.provider.attach();
    openProviders.push(result.provider);
    return result;
  };
  return { socket, a: make(publicDoc, publicToken), b: make(privateDoc, privateToken) };
}

it('does not let a visitor on a public document open a private one over the same connection', async () => {
  const { a, b } = sharedSocketProviders('', '');
  await waitFor(() => a.authenticated && b.failed);
  expect(b.failed).toBe('invalid-token');

  b.ydoc.getText('t').insert(0, 'smuggled');
  await sleep(400);
  expect(loaded(privateDoc)).toBe(false); // never even opened
  expect(await storedState(privateDoc)).toBeNull();
});

it('does not let a logged-in editor of one document open another they have no role on, over the same connection', async () => {
  const token = tokenFor(editor);
  const { a, b } = sharedSocketProviders(token, token);
  await waitFor(() => a.authenticated && b.failed);
  expect(b.failed).toBe('permission-denied');
  b.ydoc.getText('t').insert(0, 'smuggled');
  await sleep(400);
  expect(loaded(privateDoc)).toBe(false);
  expect(await storedState(privateDoc)).toBeNull();
});

// ---- Raw protocol messages, with no provider and no UI ----

const MESSAGE = { sync: 0, auth: 2 };
const SYNC = { step2: 1, update: 2 };

function frame(docName, build) {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docName);
  build(encoder);
  return encoding.toUint8Array(encoder);
}
const authFrame = (docName, token) =>
  frame(docName, (e) => {
    encoding.writeVarUint(e, MESSAGE.auth);
    encoding.writeVarUint(e, 0); // AuthMessageType.Token
    encoding.writeVarString(e, token);
  });
const syncFrame = (docName, subtype, text) =>
  frame(docName, (e) => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, text);
    encoding.writeVarUint(e, MESSAGE.sync);
    encoding.writeVarUint(e, subtype);
    encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc));
  });

async function rawSocket() {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  return socket;
}

it('ignores raw updates sent to a private document before and after a failed login', async () => {
  const socket = await rawSocket();
  socket.send(syncFrame(privateDoc, SYNC.update, 'before login')); // sent before authenticating
  socket.send(authFrame(privateDoc, '')); // a visitor: refused
  socket.send(syncFrame(privateDoc, SYNC.update, 'after refusal'));
  socket.send(syncFrame(privateDoc, SYNC.step2, 'after refusal 2'));
  await sleep(500);
  expect(loaded(privateDoc)).toBe(false);
  expect(await storedState(privateDoc)).toBeNull();
});

it('ignores raw updates and sync replies from a visitor on a view-only link, whatever message type they use', async () => {
  await pool.query("UPDATE documents SET link_access = 'viewer' WHERE id = $1", [publicDoc]);
  const socket = await rawSocket();
  socket.send(authFrame(publicDoc, '')); // allowed in, as a viewer
  await sleep(300);
  socket.send(syncFrame(publicDoc, SYNC.update, 'raw update'));
  socket.send(syncFrame(publicDoc, SYNC.step2, 'raw sync step 2'));
  await sleep(500);
  expect(server.hocuspocus.documents.get(publicDoc).getText('t').toString()).toBe('');
});

it('ignores a raw update sent for a different document than the one the visitor logged in to', async () => {
  const socket = await rawSocket();
  socket.send(authFrame(publicDoc, ''));
  await sleep(300);
  socket.send(syncFrame(privateDoc, SYNC.update, 'wrong document')); // never authenticated for this one
  await sleep(500);
  expect(loaded(privateDoc)).toBe(false);
  expect(await storedState(privateDoc)).toBeNull();
});

// ---- Visitors who can edit ----

it('saves what a visitor typed, and loads it again later', async () => {
  const visitor = await anonymous();
  visitor.ydoc.getText('t').insert(0, 'written by a visitor');
  await waitFor(() => server.hocuspocus.documents.get(publicDoc)?.getText('t').toString() === 'written by a visitor');
  visitor.provider.destroy(); // the last person leaves: the document is stored and unloaded

  await waitFor(async () => (await storedState(publicDoc)) !== null);
  await waitFor(() => !loaded(publicDoc));

  const later = await connect(url, publicDoc, tokenFor(owner));
  expect(later.ydoc.getText('t').toString()).toBe('written by a visitor');
});

it('closes a visitor who sends a message over the size limit, and keeps the document intact', async () => {
  const watcher = await connect(url, publicDoc, tokenFor(owner));
  watcher.ydoc.getText('t').insert(0, 'intact');
  const visitor = await anonymous();
  await waitFor(() => visitor.ydoc.getText('t').toString() === 'intact');

  const socket = visitor.provider.configuration.websocketProvider.webSocket;
  const closing = new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  visitor.ydoc.getText('t').insert(6, 'x'.repeat(MAX_MESSAGE_BYTES + 1)); // valid, but too big
  expect(await closing).toBe(1009);
  visitor.provider.destroy();

  expect(server.hocuspocus.documents.get(publicDoc).getText('t').toString()).toBe('intact');
  expect(watcher.ydoc.getText('t').toString()).toBe('intact');
});

it('keeps the cap on link visitors when they leave and come back, and frees the place when one leaves', async () => {
  process.env.MAX_LINK_VIEWERS = '2';
  const first = await anonymous();
  const second = await anonymous();
  expect(first.ok && second.ok).toBe(true);
  expect((await anonymous()).reason).toBe('too-many-viewers');

  second.provider.destroy();
  await waitFor(async () => (await anonymous()).ok, 5000); // the freed place can be taken
});

// ---- Things going wrong ----

it('answers "server-error", not a login prompt or a crash, when the database fails for a visitor', async () => {
  const realQuery = pool.query.bind(pool);
  vi.spyOn(pool, 'query').mockImplementation((sql, ...args) =>
    String(sql).includes('link_access') ? Promise.reject(new Error('database unavailable')) : realQuery(sql, ...args),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await anonymous()).toMatchObject({ ok: false, reason: 'server-error' });
  vi.restoreAllMocks();
  expect((await anonymous()).ok).toBe(true); // and it recovers by itself
});

it('refuses visitors for documents that do not exist or have malformed names, exactly like private ones', async () => {
  const names = ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "'; DROP TABLE documents; --", 'a'.repeat(300)];
  const reasons = [];
  for (const name of names) reasons.push((await connect(url, name, '', { timeout: 2000 })).reason);
  expect(reasons).toEqual(Array(names.length).fill('invalid-token'));
  expect((await pool.query('SELECT count(*) FROM documents')).rows[0].count).toBe('2');
});

// ---- Changing the link while people are connecting ----

async function setLink(access) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE documents SET link_access = $1 WHERE id = $2', [access, publicDoc]);
    await client.query('SELECT pg_notify($1, $2)', [
      'access_changed',
      JSON.stringify({ docId: publicDoc, userId: null, linkOnly: true }),
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

it('leaves nobody connected through the link after it is switched off, even in a storm of changes and reconnects', async () => {
  const realEditor = await connect(url, publicDoc, tokenFor(editor));
  const levels = ['viewer', 'editor', 'none', 'editor', 'viewer', 'none', 'editor', 'none'];

  // Visitors keep connecting and disconnecting while the owner keeps changing the link.
  let stop = false;
  const churn = (async () => {
    while (!stop) {
      const visitor = await connect(url, publicDoc, '', { timeout: 1500 });
      if (visitor.ok) visitor.ydoc.getText('t').insert(0, 'x');
      await sleep(20);
      visitor.provider.destroy();
    }
  })();
  for (const level of levels) {
    await setLink(level);
    await sleep(60);
  }
  stop = true;
  await churn;

  await setLink('none'); // the last word
  await sleep(500);
  const linkConnections = server.hocuspocus.documents.get(publicDoc)?.getConnections().filter((c) => c.context?.viaLink) ?? [];
  expect(linkConnections).toHaveLength(0);
  expect((await anonymous()).ok).toBe(false);
  expect(realEditor.closeReasons).toEqual([]); // the real collaborator was never touched
  realEditor.ydoc.getText('t').insert(0, 'still here');
  await waitFor(() => server.hocuspocus.documents.get(publicDoc).getText('t').toString().includes('still here'));
}, 60_000);

// ---- Positive controls: the hand-built messages above really are valid ----
// Without these, the "ignores raw messages" tests above could pass simply because the
// messages were malformed, and prove nothing.

it('control: the same raw messages ARE applied when the visitor is allowed to edit', async () => {
  const socket = await rawSocket();
  socket.send(authFrame(publicDoc, '')); // link allows editing
  await sleep(300);
  socket.send(syncFrame(publicDoc, SYNC.update, 'raw update'));
  await waitFor(() => server.hocuspocus.documents.get(publicDoc)?.getText('t').toString().includes('raw update'));
});

it('control: raw messages ARE applied to a private document for someone who really has access', async () => {
  const socket = await rawSocket();
  socket.send(authFrame(privateDoc, tokenFor(owner)));
  await sleep(300);
  socket.send(syncFrame(privateDoc, SYNC.update, 'raw update by the owner'));
  await waitFor(() => server.hocuspocus.documents.get(privateDoc)?.getText('t').toString().includes('raw update by the owner'));
});
