import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import {
  applySchema,
  connect,
  createDocument,
  createUser,
  destroyProviders,
  grant,
  startServer,
  tokenFor,
  waitFor,
} from './helpers.js';

let server, url, owner, bob, docId;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  owner = await createUser('owner');
  bob = await createUser('bob');
  docId = await createDocument(owner);
  ({ server, url } = await startServer());
});

afterEach(async () => {
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

// What the REST API does: change permissions and NOTIFY in one transaction.
async function apiChange(sql, params, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, params);
    await client.query('SELECT pg_notify($1, $2)', ['access_changed', JSON.stringify({ docId, userId })]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const connectionsOf = (userId) =>
  server.hocuspocus.documents.get(docId)?.getConnections().filter((c) => c.context.userId === userId) ?? [];
const serverText = () => server.hocuspocus.documents.get(docId)?.getText('t').toString();

it('closes a removed user\'s live connection, rejects their reconnect, and leaves others alone', async () => {
  await grant(docId, bob, 'editor');
  const ownerConn = await connect(url, docId, tokenFor(owner));
  const bobConn = await connect(url, docId, tokenFor(bob));
  expect(connectionsOf(bob)).toHaveLength(1);

  await apiChange('DELETE FROM permissions WHERE doc_id = $1 AND user_id = $2', [docId, bob], bob);

  await waitFor(() => connectionsOf(bob).length === 0);
  // The close message reaches the client a moment after the server drops the connection.
  await waitFor(() => bobConn.closeReasons.includes('access-changed'));
  expect(connectionsOf(owner)).toHaveLength(1);
  expect(ownerConn.closeReasons).toEqual([]);

  expect(await connect(url, docId, tokenFor(bob))).toMatchObject({ ok: false, reason: 'permission-denied' });
});

it('makes a downgraded editor read-only after they reconnect', async () => {
  await grant(docId, bob, 'editor');
  await connect(url, docId, tokenFor(owner)); // keeps the document open on the server
  await connect(url, docId, tokenFor(bob));

  await apiChange("UPDATE permissions SET role = 'viewer' WHERE doc_id = $1 AND user_id = $2", [docId, bob], bob);
  await waitFor(() => connectionsOf(bob).length === 0);

  const again = await connect(url, docId, tokenFor(bob));
  expect(again.ok).toBe(true);
  again.ydoc.getText('t').insert(0, 'should be dropped');
  await new Promise((r) => setTimeout(r, 300));
  expect(serverText()).toBe('');
});

it('closes every connection with document-deleted when the document is deleted', async () => {
  await grant(docId, bob, 'viewer');
  const ownerConn = await connect(url, docId, tokenFor(owner));
  const bobConn = await connect(url, docId, tokenFor(bob));

  await apiChange('DELETE FROM documents WHERE id = $1', [docId], null);

  await waitFor(() => (server.hocuspocus.documents.get(docId)?.getConnectionsCount() ?? 0) === 0);
  await waitFor(() =>
    [ownerConn, bobConn].every((conn) => conn.closeReasons.includes('document-deleted')),
  );
});

it('sends nothing to clients when the change is rolled back', async () => {
  await grant(docId, bob, 'editor');
  const bobConn = await connect(url, docId, tokenFor(bob));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM permissions WHERE doc_id = $1 AND user_id = $2', [docId, bob]);
    await client.query('SELECT pg_notify($1, $2)', ['access_changed', JSON.stringify({ docId, userId: bob })]);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  await new Promise((r) => setTimeout(r, 300));
  expect(connectionsOf(bob)).toHaveLength(1);
  expect(bobConn.closeReasons).toEqual([]);
});
