import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pool } from '../src/db.js';
import { DEMO_USERS, WELCOME_DOC_ID, seedDemo } from '../db/seedDemo.js';
import { applySchema, connect, destroyProviders, startServer, tokenFor, waitFor } from './helpers.js';

let server, url;

beforeAll(async () => {
  await applySchema();
  await pool.query('TRUNCATE users CASCADE');
  ({ server, url } = await startServer());
});

afterEach(destroyProviders);

afterAll(async () => {
  await server?.destroy();
  await pool.end();
});

const idOf = async (email) => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;

it('creates the demo users and welcome document, and is safe to run again', async () => {
  expect(await seedDemo(pool)).toEqual({ documentCreated: true });
  expect(await seedDemo(pool)).toEqual({ documentCreated: false });

  const { rows } = await pool.query(
    `SELECT u.email, p.role FROM permissions p JOIN users u ON u.id = p.user_id
      WHERE p.doc_id = $1 ORDER BY u.email`,
    [WELCOME_DOC_ID],
  );
  expect(rows).toEqual(DEMO_USERS.map(({ email, role }) => ({ email, role })).sort((a, b) => a.email.localeCompare(b.email)));
});

it('serves the welcome content, with the right access for each demo user', async () => {
  await seedDemo(pool);
  const [alice, bob, carol] = await Promise.all(DEMO_USERS.map((u) => idOf(u.email)));

  const bobConn = await connect(url, WELCOME_DOC_ID, tokenFor(bob));
  expect(bobConn.ok).toBe(true);
  const content = bobConn.ydoc.getXmlFragment('default').toString();
  expect(content).toContain('<heading level="1">Welcome to Collab Docs</heading>');
  expect(content).toContain('<bold>Carol</bold>');

  // Carol is a viewer: her edits must not reach the server.
  const carolConn = await connect(url, WELCOME_DOC_ID, tokenFor(carol));
  carolConn.ydoc.getXmlFragment('default').insert(0, [new Y.XmlText('vandalism')]);
  await new Promise((r) => setTimeout(r, 300));
  expect(server.hocuspocus.documents.get(WELCOME_DOC_ID).getXmlFragment('default').toString()).not.toContain('vandalism');

  // Alice's edits reach Bob.
  const aliceConn = await connect(url, WELCOME_DOC_ID, tokenFor(alice));
  const heading = aliceConn.ydoc.getXmlFragment('default').get(0).get(0);
  heading.insert(heading.length, '!');
  await waitFor(() => bobConn.ydoc.getXmlFragment('default').toString().includes('Welcome to Collab Docs!'));
});

it('restores a removed demo role on the next run, but keeps edits and changed roles', async () => {
  await seedDemo(pool);
  const bob = await idOf('bob@demo.example.com');
  const carol = await idOf('carol@demo.example.com');
  await pool.query('DELETE FROM permissions WHERE doc_id = $1 AND user_id = $2', [WELCOME_DOC_ID, bob]);
  await pool.query("UPDATE permissions SET role = 'editor' WHERE doc_id = $1 AND user_id = $2", [WELCOME_DOC_ID, carol]);

  await seedDemo(pool);
  const roleOf = async (id) =>
    (await pool.query('SELECT role FROM permissions WHERE doc_id = $1 AND user_id = $2', [WELCOME_DOC_ID, id])).rows[0]?.role;
  expect(await roleOf(bob)).toBe('editor');
  expect(await roleOf(carol)).toBe('editor');
});
