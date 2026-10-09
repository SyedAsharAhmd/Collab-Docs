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

let server, url, owner, editor, stranger, docId;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  owner = await createUser('owner');
  editor = await createUser('editor');
  stranger = await createUser('stranger');
  docId = await createDocument(owner);
  await grant(docId, editor, 'editor');
  ({ server, url } = await startServer());
});

afterEach(async () => {
  delete process.env.MAX_LINK_VIEWERS;
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

const setLinkAccess = (access) => pool.query('UPDATE documents SET link_access = $1 WHERE id = $2', [access, docId]);
const serverText = () => server.hocuspocus.documents.get(docId)?.getText('t').toString();
const anonymous = () => connect(url, docId, ''); // no token at all: a visitor who isn't logged in

// What the API does when the owner changes what the link allows: change it and notify.
async function changeLinkAccess(access) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE documents SET link_access = $1 WHERE id = $2', [access, docId]);
    await client.query('SELECT pg_notify($1, $2)', [
      'access_changed',
      JSON.stringify({ docId, userId: null, linkOnly: true }),
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

it('tells a visitor who is not logged in to log in while link sharing is off', async () => {
  expect(await anonymous()).toMatchObject({ ok: false, reason: 'invalid-token' });
});

it('lets a visitor in once it is on, sees live changes, and cannot change anything, even with raw updates', async () => {
  await setLinkAccess('viewer');
  const ownerConn = await connect(url, docId, tokenFor(owner));
  ownerConn.ydoc.getText('t').insert(0, 'Hello');

  const visitor = await anonymous();
  expect(visitor.ok).toBe(true);
  await waitFor(() => visitor.ydoc.getText('t').toString() === 'Hello');

  ownerConn.ydoc.getText('t').insert(5, ' world');
  await waitFor(() => visitor.ydoc.getText('t').toString() === 'Hello world'); // live

  // The visitor's own code edits its copy directly, and the provider sends the raw update.
  visitor.ydoc.getText('t').insert(0, 'HACKED ');
  await new Promise((r) => setTimeout(r, 300));
  expect(serverText()).toBe('Hello world');
  expect(ownerConn.ydoc.getText('t').toString()).toBe('Hello world');
});

it('treats a logged-in user with no role as a viewer, but never lowers a real role', async () => {
  await setLinkAccess('viewer');
  const strangerConn = await connect(url, docId, tokenFor(stranger));
  const editorConn = await connect(url, docId, tokenFor(editor));
  expect(strangerConn.ok && editorConn.ok).toBe(true);

  strangerConn.ydoc.getText('t').insert(0, 'from stranger');
  editorConn.ydoc.getText('t').insert(0, 'from editor');
  await waitFor(() => serverText() === 'from editor');
  await new Promise((r) => setTimeout(r, 300));
  expect(serverText()).toBe('from editor'); // the editor could edit, the link viewer could not
});

it('still rejects an invalid token on a public document, instead of treating it as anonymous', async () => {
  await setLinkAccess('viewer');
  expect(await connect(url, docId, 'garbage')).toMatchObject({ ok: false, reason: 'invalid-token' });
});

it('closes link visitors when sharing is switched off, but not collaborators', async () => {
  await setLinkAccess('viewer');
  const editorConn = await connect(url, docId, tokenFor(editor));
  const visitor = await anonymous();
  const loggedInViewer = await connect(url, docId, tokenFor(stranger)); // got in through the link too

  await changeLinkAccess('none');

  await waitFor(() => visitor.closeReasons.includes('access-changed') && loggedInViewer.closeReasons.includes('access-changed'));
  expect(editorConn.closeReasons).toEqual([]);

  // Reconnecting is refused now: the visitor is told to log in, the logged-in user gets no access.
  expect(await anonymous()).toMatchObject({ ok: false, reason: 'invalid-token' });
  expect(await connect(url, docId, tokenFor(stranger))).toMatchObject({ ok: false, reason: 'permission-denied' });
});

it('caps how many people can watch through the link, without affecting collaborators', async () => {
  process.env.MAX_LINK_VIEWERS = '2';
  await setLinkAccess('viewer');
  const first = await anonymous();
  const second = await anonymous();
  expect(first.ok && second.ok).toBe(true);

  expect(await anonymous()).toMatchObject({ ok: false, reason: 'too-many-viewers' });
  expect((await connect(url, docId, tokenFor(editor))).ok).toBe(true);
});

// ---- Editing through the link ----

it('lets a visitor who is not logged in edit when the link allows editing, and everyone sees it live', async () => {
  await setLinkAccess('editor');
  const ownerConn = await connect(url, docId, tokenFor(owner));
  const visitor = await anonymous();
  expect(visitor.ok).toBe(true);

  visitor.ydoc.getText('t').insert(0, 'typed by a visitor');
  await waitFor(() => ownerConn.ydoc.getText('t').toString() === 'typed by a visitor');
  expect(serverText()).toBe('typed by a visitor');

  ownerConn.ydoc.getText('t').insert(0, 'owner: ');
  await waitFor(() => visitor.ydoc.getText('t').toString() === 'owner: typed by a visitor');
});

it('takes editing away at once when the owner lowers the link to view only', async () => {
  await setLinkAccess('editor');
  const visitor = await anonymous();
  visitor.ydoc.getText('t').insert(0, 'allowed');
  await waitFor(() => serverText() === 'allowed');

  await changeLinkAccess('viewer');
  await waitFor(() => visitor.closeReasons.includes('access-changed'));

  // Back in, but read-only: this edit must be dropped.
  const again = await anonymous();
  expect(again.ok).toBe(true);
  again.ydoc.getText('t').insert(0, 'NOT ALLOWED ');
  await new Promise((r) => setTimeout(r, 300));
  expect(serverText()).toBe('allowed');
});

it('lifts a real viewer to editor through the link, and drops them back when the link is lowered', async () => {
  const viewer = await createUser('viewer');
  await grant(docId, viewer, 'viewer');
  await setLinkAccess('editor');

  const lifted = await connect(url, docId, tokenFor(viewer));
  lifted.ydoc.getText('t').insert(0, 'edited via link');
  await waitFor(() => serverText() === 'edited via link');

  await changeLinkAccess('viewer');
  await waitFor(() => lifted.closeReasons.includes('access-changed'));
  const back = await connect(url, docId, tokenFor(viewer));
  back.ydoc.getText('t').insert(0, 'blocked ');
  await new Promise((r) => setTimeout(r, 300));
  expect(serverText()).toBe('edited via link');
});

it('keeps real collaborators connected, with their own rights, when the link changes', async () => {
  await setLinkAccess('editor');
  const editorConn = await connect(url, docId, tokenFor(editor));
  await changeLinkAccess('none');
  await new Promise((r) => setTimeout(r, 300));
  expect(editorConn.closeReasons).toEqual([]);
  editorConn.ydoc.getText('t').insert(0, 'still editing');
  await waitFor(() => serverText() === 'still editing');
});
