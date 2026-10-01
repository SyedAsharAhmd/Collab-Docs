import { readFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer } from '../src/server.js';
import { pool } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Add it to collab/.env (see .env.example).');
}

export const applySchema = async () =>
  pool.query(await readFile(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));

export async function startServer() {
  const server = createServer({ port: 0, quiet: true, stopOnSignals: false });
  await server.listen();
  return { server, url: `ws://127.0.0.1:${server.address.port}` };
}

export async function createUser(name) {
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', $2) RETURNING id",
    [`${name}@example.com`, name],
  );
  return rows[0].id;
}

export const grant = (docId, userId, role) =>
  pool.query('INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)', [docId, userId, role]);

export async function createDocument(ownerId) {
  const { rows } = await pool.query('INSERT INTO documents (owner_id) VALUES ($1) RETURNING id', [ownerId]);
  await grant(rows[0].id, ownerId, 'owner');
  return rows[0].id;
}

export const tokenFor = (userId, options = { expiresIn: '1h' }) =>
  jwt.sign({ sub: userId }, process.env.JWT_SECRET, { algorithm: 'HS256', ...options });

// Every provider opened by connect(); destroy them after each test.
export const openProviders = [];

export function destroyProviders() {
  for (const provider of openProviders.splice(0)) provider.destroy();
}

// Connects like a browser would. Resolves once the server has synced the document to
// us, refused the connection, or `timeout` ms passed without either. `closeReasons`
// collects the reason of every close the server sends later.
export function connect(url, docId, token, { timeout = 3000 } = {}) {
  const ydoc = new Y.Doc();
  const closeReasons = [];
  return new Promise((resolve) => {
    const provider = new HocuspocusProvider({
      url,
      name: docId,
      document: ydoc,
      token,
      onSynced: () => resolve({ ok: true, ydoc, provider, closeReasons }),
      onAuthenticationFailed: ({ reason }) => resolve({ ok: false, reason, ydoc, provider, closeReasons }),
      onClose: ({ event }) => closeReasons.push(event.reason),
    });
    openProviders.push(provider);
    setTimeout(() => resolve({ ok: false, reason: 'timeout', ydoc, provider, closeReasons }), timeout);
  });
}

// Polls until `check` passes or the timeout expires. `check` may be async.
export async function waitFor(check, timeout = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}
