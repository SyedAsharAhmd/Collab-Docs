import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { useTestServer } from './helpers.js';

// Every kind of caller x every link setting x every document route.
//
// The expected statuses are written out by hand from the rules below, NOT computed by
// the same logic the server uses, so a mistake in the server cannot hide itself here.
//
// Rules:
//  - A token that is sent but invalid or expired is always 401. A missing token is 401
//    everywhere except the one read route, and only when the link allows it.
//  - Your role is the better of your real role and what the link gives (view or edit).
//  - Someone with no role at all and no link access gets 404 (the document "doesn't exist").
//  - A role that is too low for the route gets 403.
//  - A role that comes from the link can never rename, and never reaches owner-only routes.
const call = useTestServer();

const ROUTES = ['read', 'rename', 'delete', 'setLink', 'listPeople', 'addPerson', 'removePerson'];

// Statuses per route, in the order of ROUTES. N = 404, F = 403.
const EXPECTED = {
  // No token at all.
  anonymous: {
    none: [404, 401, 401, 401, 401, 401, 401],
    viewer: [200, 401, 401, 401, 401, 401, 401],
    editor: [200, 401, 401, 401, 401, 401, 401],
  },
  // A token that is sent but wrong or expired is never treated as "no token".
  garbageToken: {
    none: [401, 401, 401, 401, 401, 401, 401],
    viewer: [401, 401, 401, 401, 401, 401, 401],
    editor: [401, 401, 401, 401, 401, 401, 401],
  },
  expiredToken: {
    none: [401, 401, 401, 401, 401, 401, 401],
    viewer: [401, 401, 401, 401, 401, 401, 401],
    editor: [401, 401, 401, 401, 401, 401, 401],
  },
  // Logged in, but no role on this document.
  stranger: {
    none: [404, 404, 404, 404, 404, 404, 404],
    viewer: [200, 403, 403, 403, 403, 403, 403],
    editor: [200, 403, 403, 403, 403, 403, 403], // editor via the link: can edit content, not rename
  },
  viewer: {
    none: [200, 403, 403, 403, 403, 403, 403],
    viewer: [200, 403, 403, 403, 403, 403, 403],
    editor: [200, 403, 403, 403, 403, 403, 403], // lifted to editor by the link, still no rename
  },
  editor: {
    none: [200, 200, 403, 403, 403, 403, 403],
    viewer: [200, 200, 403, 403, 403, 403, 403],
    editor: [200, 200, 403, 403, 403, 403, 403], // a real editor can rename, link or not
  },
  owner: {
    none: [200, 200, 204, 200, 200, 201, 204],
    viewer: [200, 200, 204, 200, 200, 201, 204],
    editor: [200, 200, 204, 200, 200, 201, 204],
  },
};

let users; // name -> { id, email, token }
const tokens = { garbageToken: 'garbage' };
let counter = 0; // every document gets its own people, so emails must be unique

async function register(name) {
  const email = `${name.toLowerCase()}${++counter}@example.com`;
  const { body } = await call('POST', '/register', { body: { name, email, password: 'password123' } });
  return { id: body.user.id, email, token: body.token };
}

// Registers the people once per test (password hashing is slow on purpose).
async function createPeople() {
  users = {
    owner: await register('Owner'),
    editor: await register('Editor'),
    viewer: await register('Viewer'),
    stranger: await register('Stranger'),
    target: await register('Target'), // someone the owner removes in the removePerson route
    newcomer: await register('Newcomer'), // someone the owner adds in the addPerson route
  };
  // An expired token for a real user: correctly signed, but past its expiry.
  tokens.expiredToken = jwt.sign({ sub: users.owner.id, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
  });
}

// A fresh document in the given link state, shared with the people above.
async function createDoc(linkAccess) {
  const doc = (await call('POST', '/documents', { token: users.owner.token, body: { title: 'Plan' } })).body.document;
  const grant = (user, role) =>
    pool.query('INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)', [doc.id, user.id, role]);
  await grant(users.editor, 'editor');
  await grant(users.viewer, 'viewer');
  await grant(users.target, 'viewer');
  if (linkAccess !== 'none') {
    const res = await call('PUT', `/documents/${doc.id}/link-access`, { token: users.owner.token, body: { access: linkAccess } });
    expect(res.status).toBe(200);
  }
  doc.linkAccess = linkAccess;
  return doc;
}

// Registering many people is slow on purpose (bcrypt), so these tests get more time.
const TIMEOUT = 60_000;

function request(route, doc, token) {
  const id = doc.id;
  switch (route) {
    case 'read':
      return call('GET', `/documents/${id}`, { token });
    case 'rename':
      return call('PATCH', `/documents/${id}`, { token, body: { title: 'Renamed' } });
    case 'delete':
      return call('DELETE', `/documents/${id}`, { token });
    case 'setLink':
      // Re-sets the current value, so the state under test never changes.
      return call('PUT', `/documents/${id}/link-access`, { token, body: { access: doc.linkAccess } });
    case 'listPeople':
      return call('GET', `/documents/${id}/permissions`, { token });
    case 'addPerson':
      return call('POST', `/documents/${id}/permissions`, { token, body: { email: users.newcomer.email, role: 'viewer' } });
    case 'removePerson':
      return call('DELETE', `/documents/${id}/permissions/${users.target.id}`, { token });
  }
}

const tokenFor = (identity) => {
  if (identity === 'anonymous') return undefined;
  if (identity === 'garbageToken' || identity === 'expiredToken') return tokens[identity];
  return users[identity].token;
};

describe.each(['none', 'viewer', 'editor'])('with the link set to %s', (linkAccess) => {
  it.each(Object.keys(EXPECTED))('%s gets the right answer on every route', async (identity) => {
    await createPeople();
    const actual = {};
    for (const route of ROUTES) {
      // A fresh document for each route: delete and remove must not disturb the others.
      const doc = await createDoc(linkAccess);
      const res = await request(route, doc, tokenFor(identity));
      actual[route] = res.status;

      // Nothing here may leak who owns the document or its collaborators to people who
      // are not allowed to see that (the owner and real collaborators may).
      if (!['owner'].includes(identity)) {
        expect(res.text, `${identity}/${route} leaked the owner`).not.toContain(users.owner.email);
        expect(res.text, `${identity}/${route} leaked the owner id`).not.toContain(users.owner.id);
      }
    }
    const expected = Object.fromEntries(ROUTES.map((route, i) => [route, EXPECTED[identity][linkAccess][i]]));
    expect(actual).toEqual(expected);
  }, TIMEOUT);
});

describe('routes that do not depend on one document', () => {
  it('need a login whatever the link says: list and create', async () => {
    await createPeople();
    await createDoc('editor');
    expect((await call('GET', '/documents')).status).toBe(401);
    expect((await call('POST', '/documents')).status).toBe(401);
    expect((await call('GET', '/documents', { token: 'garbage' })).status).toBe(401);
    expect((await call('GET', '/documents', { token: users.stranger.token })).body.documents).toEqual([]); // never lists link documents
  });

  it('treats oddly formed Authorization headers as a failed login, never as anonymous', async () => {
    await createPeople();
    const doc = await createDoc('editor'); // anonymous would be allowed to read this
    for (const value of ['Bearer', 'Bearer ', 'bearer abc', 'Basic abc', 'Token abc', 'Bearer null', 'Bearer undefined', 'Bearer ..', 'Bearer a b']) {
      const res = await call('GET', `/documents/${doc.id}`, { headers: { Authorization: value } });
      expect(res.status, `Authorization: ${value}`).toBe(401);
    }
  });

  it('answers 404, never 500, for malformed or hostile document ids, even for visitors', async () => {
    await createPeople();
    await createDoc('editor');
    const ids = ['not-a-uuid', "'; DROP TABLE documents; --", '%00', 'a'.repeat(5000), '../../etc/passwd', '00000000-0000-4000-8000-000000000000'];
    for (const id of ids) {
      const res = await call('GET', `/documents/${encodeURIComponent(id)}`);
      expect(res.status, `id ${id.slice(0, 20)}`).toBe(404);
    }
    // And the tables are still there.
    expect((await pool.query('SELECT count(*) FROM documents')).rows[0].count).toBe('1');
  });
});
