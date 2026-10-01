import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { pool } from '../src/db.js';
import {
  applySchema,
  connect,
  createDocument,
  createUser,
  destroyProviders,
  startServer,
  tokenFor,
  waitFor,
} from './helpers.js';

let server, url, docId, token;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  const owner = await createUser('owner');
  docId = await createDocument(owner);
  token = tokenFor(owner);
  ({ server, url } = await startServer());
});

afterEach(async () => {
  vi.restoreAllMocks();
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

// Writes a document's state the way onStoreDocument does, without a server involved.
async function storeText(id, text) {
  const ydoc = new Y.Doc();
  ydoc.getText('t').insert(0, text);
  await pool.query('UPDATE documents SET ydoc_state = $1 WHERE id = $2', [
    Buffer.from(Y.encodeStateAsUpdate(ydoc)),
    id,
  ]);
}

// Reads back what is stored in Postgres, or null if nothing has been stored yet.
async function storedText(id) {
  const { rows } = await pool.query('SELECT ydoc_state FROM documents WHERE id = $1', [id]);
  if (!rows[0].ydoc_state) return null;
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, rows[0].ydoc_state);
  return ydoc.getText('t').toString();
}

it('loads a stored document when nobody has it open', async () => {
  await storeText(docId, 'from the database');
  const client = await connect(url, docId, token);
  expect(client.ok).toBe(true);
  expect(client.ydoc.getText('t').toString()).toBe('from the database');
});

it('stores changes shortly after typing stops, while people are still connected', async () => {
  const client = await connect(url, docId, token);
  client.ydoc.getText('t').insert(0, 'autosaved');
  // Debounce is 2 s; allow a margin.
  await waitFor(async () => (await storedText(docId)) === 'autosaved', 4000);
});

it('stores right away when the last person leaves', async () => {
  const client = await connect(url, docId, token);
  client.ydoc.getText('t').insert(0, 'bye');
  await waitFor(() => server.hocuspocus.documents.get(docId)?.getText('t').toString() === 'bye');

  client.provider.destroy();
  // Well under the 2 s debounce: the last disconnect triggers the store immediately.
  await waitFor(async () => (await storedText(docId)) === 'bye', 1000);
});

it('keeps content across a collab server restart', async () => {
  const before = await connect(url, docId, token);
  before.ydoc.getText('t').insert(0, 'survives restart');
  await waitFor(() => server.hocuspocus.documents.get(docId)?.getText('t').toString() === 'survives restart');

  // destroy() is what a SIGTERM triggers: it flushes pending stores before exiting.
  await server.destroy();
  destroyProviders();
  ({ server, url } = await startServer());

  const after = await connect(url, docId, token);
  expect(after.ok).toBe(true);
  expect(after.ydoc.getText('t').toString()).toBe('survives restart');
});

it('refuses to open a document it cannot load, and never overwrites what is stored', async () => {
  await storeText(docId, 'precious');

  // Simulate the database failing for the load query only (auth queries still work).
  const realQuery = pool.query.bind(pool);
  vi.spyOn(pool, 'query').mockImplementation((sql, ...args) =>
    String(sql).startsWith('SELECT ydoc_state')
      ? Promise.reject(new Error('database unavailable'))
      : realQuery(sql, ...args),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {}); // expected failure logs

  const client = await connect(url, docId, token, { timeout: 1500 });
  expect(client.ok).toBe(false);
  // No empty document was kept in memory, so nothing empty can be stored later.
  expect(server.hocuspocus.documents.has(docId)).toBe(false);
  client.provider.destroy();

  vi.restoreAllMocks();
  expect(await storedText(docId)).toBe('precious');
  const retry = await connect(url, docId, token);
  expect(retry.ydoc.getText('t').toString()).toBe('precious');
});
