import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer } from '../src/server.js';
import { pool } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Add it to collab/.env (see .env.example).');
}

let server;
let url;
const providers = [];

beforeAll(async () => {
  await pool.query(await readFile(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
  server = createServer({ port: 0, quiet: true, stopOnSignals: false });
  await server.listen();
  url = `ws://127.0.0.1:${server.address.port}`;
});

beforeEach(() => pool.query('TRUNCATE users CASCADE'));

afterEach(() => {
  for (const provider of providers.splice(0)) provider.destroy();
});

afterAll(async () => {
  await server?.destroy();
  await pool.end();
});

async function createUser(name) {
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, name) VALUES ($1, 'not-a-real-hash', $2) RETURNING id",
    [`${name}@example.com`, name],
  );
  return rows[0].id;
}

async function createDocument(ownerId) {
  const { rows } = await pool.query('INSERT INTO documents (owner_id) VALUES ($1) RETURNING id', [ownerId]);
  await grant(rows[0].id, ownerId, 'owner');
  return rows[0].id;
}

const grant = (docId, userId, role) =>
  pool.query('INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)', [docId, userId, role]);

const tokenFor = (userId, options = { expiresIn: '1h' }) =>
  jwt.sign({ sub: userId }, process.env.JWT_SECRET, { algorithm: 'HS256', ...options });

// Connects like a browser would. Resolves once the server has either synced the
// document to us or refused the connection.
function connect(docId, token) {
  const ydoc = new Y.Doc();
  return new Promise((resolve) => {
    const provider = new HocuspocusProvider({
      url,
      name: docId,
      document: ydoc,
      token,
      onSynced: () => resolve({ ok: true, ydoc, provider }),
      onAuthenticationFailed: ({ reason }) => resolve({ ok: false, reason, ydoc, provider }),
    });
    providers.push(provider);
  });
}

// Polls until `check` passes or the timeout expires.
async function waitFor(check, timeout = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const serverText = (docId) => server.hocuspocus.documents.get(docId)?.getText('t').toString();

let owner, other, docId;

beforeEach(async () => {
  owner = await createUser('owner');
  other = await createUser('other');
  docId = await createDocument(owner);
});

describe('onAuthenticate', () => {
  it('accepts the owner', async () => {
    expect((await connect(docId, tokenFor(owner))).ok).toBe(true);
  });

  it('rejects a missing, forged, or expired token with invalid-token', async () => {
    const forged = jwt.sign({ sub: owner }, 'some-other-secret');
    const expired = tokenFor(owner, { expiresIn: -10 });
    for (const token of ['', 'garbage', forged, expired]) {
      expect(await connect(docId, token)).toMatchObject({ ok: false, reason: 'invalid-token' });
    }
  });

  it('rejects a user with no role, a missing document, and a malformed name alike', async () => {
    const token = tokenFor(other);
    const results = [
      await connect(docId, token),
      await connect('00000000-0000-4000-8000-000000000000', token),
      await connect('not-a-uuid', token),
    ];
    for (const result of results) expect(result).toMatchObject({ ok: false, reason: 'permission-denied' });
  });

  it('never sends document content to a rejected client', async () => {
    const ownerConn = await connect(docId, tokenFor(owner));
    ownerConn.ydoc.getText('t').insert(0, 'secret');
    await waitFor(() => serverText(docId) === 'secret');

    const outsider = await connect(docId, tokenFor(other));
    expect(outsider.ok).toBe(false);
    expect(outsider.ydoc.getText('t').toString()).toBe('');
  });
});

describe('sync', () => {
  it('shows each editor the other one\'s edits', async () => {
    await grant(docId, other, 'editor');
    const a = await connect(docId, tokenFor(owner));
    const b = await connect(docId, tokenFor(other));

    a.ydoc.getText('t').insert(0, 'Hello');
    await waitFor(() => b.ydoc.getText('t').toString() === 'Hello');
    b.ydoc.getText('t').insert(5, ' world');
    await waitFor(() => a.ydoc.getText('t').toString() === 'Hello world');
  });

  it('ends with identical text when both type at the same position at once', async () => {
    await grant(docId, other, 'editor');
    const a = await connect(docId, tokenFor(owner));
    const b = await connect(docId, tokenFor(other));

    // Both insert at index 0 before either has seen the other's change.
    a.ydoc.getText('t').insert(0, 'AAA');
    b.ydoc.getText('t').insert(0, 'BBB');

    const textA = () => a.ydoc.getText('t').toString();
    const textB = () => b.ydoc.getText('t').toString();
    await waitFor(() => textA().length === 6 && textA() === textB());
    expect(textA()).toMatch(/^(AAABBB|BBBAAA)$/);
    expect(serverText(docId)).toBe(textA());
  });
});

describe('viewers', () => {
  it('receive live changes but cannot change the document, even from a custom client', async () => {
    await grant(docId, other, 'viewer');
    const editor = await connect(docId, tokenFor(owner));
    const viewer = await connect(docId, tokenFor(other));

    editor.ydoc.getText('t').insert(0, 'Hello');
    await waitFor(() => viewer.ydoc.getText('t').toString() === 'Hello');

    // This test client has no read-only UI: it edits its Y.Doc directly and the
    // provider sends the raw Yjs update, exactly as a malicious client could.
    viewer.ydoc.getText('t').insert(0, 'HACKED ');
    await new Promise((r) => setTimeout(r, 300));

    expect(serverText(docId)).toBe('Hello');
    expect(editor.ydoc.getText('t').toString()).toBe('Hello');
  });
});
