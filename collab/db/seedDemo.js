// Creates three public demo users and a welcome document they share, so a visitor can
// try live editing and permissions without signing up. Runs before the collab server
// starts on Render (see render.yaml); locally: npm run seed:demo
//
// Idempotent: only what is missing is created. If a visitor deletes the welcome
// document, the next deploy brings it back; if they edit it, their edits stay.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';

// The password is public (it's in the README), so its bcrypt hash isn't a secret.
// Precomputed so this package doesn't need bcrypt: bcrypt.hashSync('try-collab-docs', 12)
export const DEMO_PASSWORD = 'try-collab-docs';
const DEMO_PASSWORD_HASH = '$2b$12$3ZPBolxlvjbgwXd9Z1.ijewL6wYOUwidUHDiZZutmc0hU3zBZOgo2';

export const DEMO_USERS = [
  { name: 'Alice (demo)', email: 'alice@demo.example.com', role: 'owner' },
  { name: 'Bob (demo)', email: 'bob@demo.example.com', role: 'editor' },
  { name: 'Carol (demo)', email: 'carol@demo.example.com', role: 'viewer' },
];

// A fixed id, so the seed can tell whether the welcome document still exists.
export const WELCOME_DOC_ID = 'de000000-0000-4000-8000-000000000001';

// The welcome document's content, written the way Tiptap's Collaboration extension
// stores it: an XmlFragment named "default", one XmlElement per node (named after the
// node type, with its attributes), and XmlText whose formatting is the marks.
function welcomeDocumentState() {
  const ydoc = new Y.Doc();
  const text = (...runs) => {
    const node = new Y.XmlText();
    let offset = 0;
    for (const run of runs) {
      const [content, marks] = typeof run === 'string' ? [run, {}] : run;
      node.insert(offset, content, marks);
      offset += content.length;
    }
    return node;
  };
  const element = (name, children, attributes = {}) => {
    const node = new Y.XmlElement(name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    node.insert(0, children);
    return node;
  };
  const paragraph = (...runs) => element('paragraph', [text(...runs)]);
  const list = (type, items) => element(type, items.map((runs) => element('listItem', [paragraph(...runs)])));
  const bold = (content) => [content, { bold: {} }];

  ydoc.getXmlFragment('default').insert(0, [
    element('heading', [text('Welcome to Collab Docs')], { level: 1 }),
    paragraph('Three demo users share this document. Log in as two of them in two different browsers (or one normal and one private window), and type: changes appear live for everyone.'),
    list('bulletList', [
      [bold('Alice'), ' owns it: she can edit, share, rename and delete it.'],
      [bold('Bob'), ' is an editor: he can edit and rename it.'],
      [bold('Carol'), ' is a viewer: she sees every change live, but cannot edit it, even by sending raw updates from her own code.'],
    ]),
    element('heading', [text('Things to try')], { level: 2 }),
    list('orderedList', [
      ['Put Alice and Bob’s cursors at the same spot and type at once. Both edits survive.'],
      ['Go offline in one browser, keep typing, then come back. The edits merge.'],
      ['As Alice, open ', bold('Share'), ' and switch Bob to viewer: his editor turns read-only within a second.'],
    ]),
    paragraph('Anyone with the demo passwords can edit this page, so it may look different from how it started.'),
  ]);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

export async function seedDemo(pool) {
  // The API's start command creates the tables too; whichever server starts first wins.
  await pool.query(await readFile(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = {};
    for (const user of DEMO_USERS) {
      await client.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [user.email, DEMO_PASSWORD_HASH, user.name],
      );
      const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [user.email]);
      ids[user.email] = rows[0].id;
    }

    const owner = DEMO_USERS.find((u) => u.role === 'owner');
    const { rowCount: created } = await client.query(
      `INSERT INTO documents (id, title, owner_id, ydoc_state) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [WELCOME_DOC_ID, 'Welcome to Collab Docs', ids[owner.email], welcomeDocumentState()],
    );
    // Restore missing roles (e.g. Alice removed Bob); a changed role is left as it is.
    for (const user of DEMO_USERS) {
      await client.query(
        'INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (doc_id, user_id) DO NOTHING',
        [WELCOME_DOC_ID, ids[user.email], user.role],
      );
    }
    await client.query('COMMIT');
    return { documentCreated: created === 1 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Run as a script: seed, report, and never block the server from starting.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const { documentCreated } = await seedDemo(pool);
    console.log(`Demo seed: users ready; welcome document ${documentCreated ? 'created' : 'already there'}.`);
  } catch (err) {
    console.error('Demo seed failed (the server starts anyway):', err.message);
  } finally {
    await pool.end();
  }
}
