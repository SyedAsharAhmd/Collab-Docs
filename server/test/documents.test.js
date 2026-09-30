import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { useTestServer } from './helpers.js';

const call = useTestServer();

async function registerUser(name) {
  const { body } = await call('POST', '/register', {
    body: { name, email: `${name.toLowerCase()}@example.com`, password: 'password123' },
  });
  return { id: body.user.id, token: body.token };
}

// Sharing arrives in M5; until then tests grant roles directly in the database.
const grant = (docId, userId, role) =>
  pool.query('INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)', [docId, userId, role]);

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let owner, other, doc;

beforeEach(async () => {
  owner = await registerUser('Owner');
  other = await registerUser('Other');
  doc = (await call('POST', '/documents', { token: owner.token, body: { title: 'Plan' } })).body.document;
});

it('requires a valid token on every documents endpoint', async () => {
  expect((await call('GET', '/documents')).status).toBe(401);
  expect((await call('POST', '/documents')).status).toBe(401);
  expect((await call('GET', `/documents/${doc.id}`, { token: 'garbage' })).status).toBe(401);
});

describe('POST /documents', () => {
  it('creates a document and makes the creator its owner', async () => {
    expect(doc).toEqual({ id: expect.any(String), title: 'Plan', updated_at: expect.any(String), role: 'owner' });
    const { rows } = await pool.query('SELECT user_id, role FROM permissions WHERE doc_id = $1', [doc.id]);
    expect(rows).toEqual([{ user_id: owner.id, role: 'owner' }]);
  });

  it('uses a default title when none is given', async () => {
    const res = await call('POST', '/documents', { token: owner.token });
    expect(res.status).toBe(201);
    expect(res.body.document.title).toBe('Untitled document');
  });

  it('rejects a blank or too-long title', async () => {
    expect((await call('POST', '/documents', { token: owner.token, body: { title: '  ' } })).status).toBe(400);
    const long = 'x'.repeat(201);
    expect((await call('POST', '/documents', { token: owner.token, body: { title: long } })).status).toBe(400);
  });
});

describe('GET /documents', () => {
  it('lists only documents the caller has a role on, with that role', async () => {
    const shared = (await call('POST', '/documents', { token: other.token, body: { title: 'Shared' } })).body.document;
    await call('POST', '/documents', { token: other.token, body: { title: 'Private' } });
    await grant(shared.id, owner.id, 'viewer');

    const res = await call('GET', '/documents', { token: owner.token });
    expect(res.status).toBe(200);
    const summary = res.body.documents.map(({ title, role }) => ({ title, role }));
    expect(summary).toHaveLength(2);
    expect(summary).toEqual(expect.arrayContaining([
      { title: 'Plan', role: 'owner' },
      { title: 'Shared', role: 'viewer' },
    ]));
  });
});

describe('GET /documents/:id', () => {
  it('returns the document to anyone with a role', async () => {
    await grant(doc.id, other.id, 'viewer');
    const res = await call('GET', `/documents/${doc.id}`, { token: other.token });
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ id: doc.id, title: 'Plan', role: 'viewer' });
  });

  it('gives an identical 404 for "no access" and "does not exist"', async () => {
    const noAccess = await call('GET', `/documents/${doc.id}`, { token: other.token });
    const missing = await call('GET', `/documents/${MISSING_ID}`, { token: other.token });
    expect(noAccess.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(noAccess.text).toBe(missing.text);
  });

  it('returns 404, not 500, for a malformed id', async () => {
    expect((await call('GET', '/documents/not-a-uuid', { token: owner.token })).status).toBe(404);
  });
});

describe('PATCH /documents/:id (rename)', () => {
  const rename = (token, title = 'Renamed') => call('PATCH', `/documents/${doc.id}`, { token, body: { title } });

  it('lets the owner and editors rename', async () => {
    expect((await rename(owner.token)).body.document.title).toBe('Renamed');
    await grant(doc.id, other.id, 'editor');
    expect((await rename(other.token, 'Again')).status).toBe(200);
  });

  it('gives a viewer 403 and a stranger 404', async () => {
    expect((await rename(other.token)).status).toBe(404);
    await grant(doc.id, other.id, 'viewer');
    expect((await rename(other.token)).status).toBe(403);
  });

  it('rejects an invalid title', async () => {
    expect((await rename(owner.token, '')).status).toBe(400);
  });
});

describe('DELETE /documents/:id', () => {
  it('lets only the owner delete, and removes its permissions', async () => {
    await grant(doc.id, other.id, 'editor');
    expect((await call('DELETE', `/documents/${doc.id}`, { token: other.token })).status).toBe(403);

    expect((await call('DELETE', `/documents/${doc.id}`, { token: owner.token })).status).toBe(204);
    expect((await call('GET', `/documents/${doc.id}`, { token: owner.token })).status).toBe(404);
    const { rowCount } = await pool.query('SELECT 1 FROM permissions WHERE doc_id = $1', [doc.id]);
    expect(rowCount).toBe(0);
  });

  it('gives a stranger 404', async () => {
    expect((await call('DELETE', `/documents/${doc.id}`, { token: other.token })).status).toBe(404);
  });
});
