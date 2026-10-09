import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
} from './helpers.js';

// Every kind of caller x every link setting, on the live connection.
//
// The expected outcomes are written by hand from the rules, not computed by the code
// under test. "edits" means: an edit this client makes really reaches the server's copy.
//
// Rules: a token that is sent but wrong or expired is always "invalid-token". No token
// means a visitor: told to log in unless the link lets them in. Logged in without a role
// and without link access: "permission-denied". The role is the better of the real role
// and what the link gives; "viewer" can never edit, whatever the client sends.
const DENIED_LOGIN = { ok: false, reason: 'invalid-token' };
const DENIED = { ok: false, reason: 'permission-denied' };
const WATCH = { ok: true, edits: false };
const EDIT = { ok: true, edits: true };

const EXPECTED = {
  visitor: { none: DENIED_LOGIN, viewer: WATCH, editor: EDIT },
  garbageToken: { none: DENIED_LOGIN, viewer: DENIED_LOGIN, editor: DENIED_LOGIN },
  expiredToken: { none: DENIED_LOGIN, viewer: DENIED_LOGIN, editor: DENIED_LOGIN },
  stranger: { none: DENIED, viewer: WATCH, editor: EDIT },
  viewer: { none: WATCH, viewer: WATCH, editor: EDIT }, // a real viewer is lifted by an edit link
  editor: { none: EDIT, viewer: EDIT, editor: EDIT }, // never lowered by a view link
  owner: { none: EDIT, viewer: EDIT, editor: EDIT },
};

let server, url, ids;

beforeAll(applySchema);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  ids = {
    owner: await createUser('owner'),
    editor: await createUser('editor'),
    viewer: await createUser('viewer'),
    stranger: await createUser('stranger'),
  };
  ({ server, url } = await startServer());
});

afterEach(async () => {
  destroyProviders();
  await server?.destroy();
});

afterAll(() => pool.end());

function tokenForIdentity(identity) {
  if (identity === 'visitor') return '';
  if (identity === 'garbageToken') return 'garbage';
  if (identity === 'expiredToken') return tokenFor(ids.owner, { expiresIn: -60 });
  return tokenFor(ids[identity]);
}

describe.each(['none', 'viewer', 'editor'])('with the link set to %s', (linkAccess) => {
  it.each(Object.keys(EXPECTED))('%s: connects (or is refused) as expected, and edits only if allowed', async (identity) => {
    const docId = await createDocument(ids.owner);
    await grant(docId, ids.editor, 'editor');
    await grant(docId, ids.viewer, 'viewer');
    await pool.query('UPDATE documents SET link_access = $1 WHERE id = $2', [linkAccess, docId]);

    const expected = EXPECTED[identity][linkAccess];
    const client = await connect(url, docId, tokenForIdentity(identity));
    expect(client.ok).toBe(expected.ok);
    if (!expected.ok) {
      expect(client.reason).toBe(expected.reason);
      // A refused client never receives or changes anything.
      expect(client.ydoc.getText('t').toString()).toBe('');
      expect(server.hocuspocus.documents.get(docId)?.getText('t').toString() ?? '').toBe('');
      return;
    }

    client.ydoc.getText('t').insert(0, 'probe');
    await new Promise((r) => setTimeout(r, 400));
    const onServer = server.hocuspocus.documents.get(docId).getText('t').toString();
    expect(onServer).toBe(expected.edits ? 'probe' : '');
  });
});
