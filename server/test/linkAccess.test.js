import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ACCESS_CHANNEL } from '../src/accessEvents.js';
import { pool } from '../src/db.js';
import { useTestServer } from './helpers.js';

const call = useTestServer();

async function registerUser(name) {
  const email = `${name.toLowerCase()}@example.com`;
  const { body } = await call('POST', '/register', { body: { name, email, password: 'password123' } });
  return { id: body.user.id, email, token: body.token };
}

const grant = (docId, userId, role) =>
  pool.query('INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)', [docId, userId, role]);

let owner, editor, stranger, doc;

beforeEach(async () => {
  owner = await registerUser('Owner');
  editor = await registerUser('Editor');
  stranger = await registerUser('Stranger');
  doc = (await call('POST', '/documents', { token: owner.token, body: { title: 'Plan' } })).body.document;
  await grant(doc.id, editor.id, 'editor');
});

const setLinkAccess = (token, access) =>
  call('PUT', `/documents/${doc.id}/link-access`, { token, body: { access } });
const view = (token) => call('GET', `/documents/${doc.id}`, { token });

describe('viewing without a login', () => {
  it('is refused while link sharing is off, the default, exactly like a missing document', async () => {
    const anonymous = await view();
    const missing = await call('GET', '/documents/00000000-0000-4000-8000-000000000000');
    expect(anonymous.status).toBe(404);
    expect(anonymous.text).toBe(missing.text);
  });

  it('works as a viewer once the owner switches it on, and shows nothing about the owner', async () => {
    expect((await setLinkAccess(owner.token, 'viewer')).body).toEqual({ link_access: 'viewer' });

    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.document).toEqual({
      id: doc.id,
      title: 'Plan',
      updated_at: expect.any(String),
      link_access: 'viewer',
      role: 'viewer',
      via_link: true,
    });
    expect(res.text).not.toContain(owner.email);
    expect(res.text).not.toContain(owner.id);
  });

  it('is refused again after the owner switches it off', async () => {
    await setLinkAccess(owner.token, 'viewer');
    await setLinkAccess(owner.token, 'none');
    expect((await view()).status).toBe(404);
  });

  it('also gives a logged-in user with no role viewer access, but not a place in their list', async () => {
    await setLinkAccess(owner.token, 'viewer');
    expect((await view(stranger.token)).body.document).toMatchObject({ role: 'viewer', via_link: true });
    expect((await call('GET', '/documents', { token: stranger.token })).body.documents).toEqual([]);
  });

  it('never lowers a role the user really has', async () => {
    await setLinkAccess(owner.token, 'viewer');
    expect((await view(editor.token)).body.document).toMatchObject({ role: 'editor', via_link: false });
    expect((await view(owner.token)).body.document).toMatchObject({ role: 'owner', via_link: false });
  });

  it('is still a 401 for an invalid or expired token, never a silent downgrade to anonymous', async () => {
    await setLinkAccess(owner.token, 'viewer');
    expect((await view('garbage')).status).toBe(401);
  });
});

describe('what a link never allows', () => {
  beforeEach(() => setLinkAccess(owner.token, 'viewer'));

  it('needs a login for every other documents route', async () => {
    const id = doc.id;
    const anonymous = [
      await call('GET', '/documents'),
      await call('POST', '/documents'),
      await call('PATCH', `/documents/${id}`, { body: { title: 'x' } }),
      await call('DELETE', `/documents/${id}`),
      await call('PUT', `/documents/${id}/link-access`, { body: { access: 'none' } }),
      await call('GET', `/documents/${id}/permissions`),
      await call('POST', `/documents/${id}/permissions`, { body: { email: 'a@b.co', role: 'editor' } }),
    ];
    expect(anonymous.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it('gives a logged-in link viewer 403 (they can see it, but not change it)', async () => {
    expect((await call('PATCH', `/documents/${doc.id}`, { token: stranger.token, body: { title: 'x' } })).status).toBe(403);
    expect((await call('DELETE', `/documents/${doc.id}`, { token: stranger.token })).status).toBe(403);
    expect((await call('GET', `/documents/${doc.id}/permissions`, { token: stranger.token })).status).toBe(403);
    expect((await setLinkAccess(stranger.token, 'none')).status).toBe(403);
    const { rows } = await pool.query('SELECT title, link_access FROM documents WHERE id = $1', [doc.id]);
    expect(rows[0]).toEqual({ title: 'Plan', link_access: 'viewer' });
  });
});

describe('PUT /documents/:id/link-access', () => {
  it('is owner only: editors get 403, strangers 404 while it is off', async () => {
    expect((await setLinkAccess(editor.token, 'viewer')).status).toBe(403);
    expect((await setLinkAccess(stranger.token, 'viewer')).status).toBe(404);
    const { rows } = await pool.query('SELECT link_access FROM documents WHERE id = $1', [doc.id]);
    expect(rows[0].link_access).toBe('none');
  });

  it('accepts "none", "viewer", and "editor", but never "owner": a link cannot make anyone an owner', async () => {
    for (const access of ['owner', 'admin', '', undefined, 1]) {
      expect((await setLinkAccess(owner.token, access)).status).toBe(400);
    }
    for (const access of ['viewer', 'editor', 'none']) {
      expect((await setLinkAccess(owner.token, access)).body).toEqual({ link_access: access });
      expect((await view(owner.token)).body.document.link_access).toBe(access);
    }
  });
});

describe('editing through the link', () => {
  beforeEach(() => setLinkAccess(owner.token, 'editor'));

  it('gives visitors who are not logged in the editor role, marked as coming from the link', async () => {
    expect((await view()).body.document).toMatchObject({ role: 'editor', via_link: true, link_access: 'editor' });
    expect((await view(stranger.token)).body.document).toMatchObject({ role: 'editor', via_link: true });
  });

  it('still needs a login for every route that is not reading, and never reaches owner-only routes', async () => {
    const id = doc.id;
    const anonymous = [
      await call('PATCH', `/documents/${id}`, { body: { title: 'x' } }),
      await call('DELETE', `/documents/${id}`),
      await call('PUT', `/documents/${id}/link-access`, { body: { access: 'none' } }),
      await call('GET', `/documents/${id}/permissions`),
    ];
    expect(anonymous.map((r) => r.status)).toEqual([401, 401, 401, 401]);

    // A logged-in user with no role gets the editor role through the link, but nothing above it.
    expect((await call('DELETE', `/documents/${id}`, { token: stranger.token })).status).toBe(403);
    expect((await call('GET', `/documents/${id}/permissions`, { token: stranger.token })).status).toBe(403);
    expect((await setLinkAccess(stranger.token, 'none')).status).toBe(403);
  });

  it('lets link editors change the content but not rename the document', async () => {
    const rename = (token) => call('PATCH', `/documents/${doc.id}`, { token, body: { title: 'Renamed' } });
    expect((await rename(stranger.token)).status).toBe(403);
    expect((await call('GET', `/documents/${doc.id}`, { token: owner.token })).body.document.title).toBe('Plan');
    // A real editor can still rename.
    expect((await rename(editor.token)).status).toBe(200);
  });

  it('uses the better of a real role and the link, and reports where the role comes from', async () => {
    const viewerUser = await registerUser('Viewer');
    await grant(doc.id, viewerUser.id, 'viewer');
    // A real viewer is lifted to editor by the link, and loses that if the link is lowered.
    expect((await view(viewerUser.token)).body.document).toMatchObject({ role: 'editor', via_link: true });
    await setLinkAccess(owner.token, 'viewer');
    expect((await view(viewerUser.token)).body.document).toMatchObject({ role: 'viewer', via_link: false });
    // A real editor is never lowered by a view-only link, and the owner is always the owner.
    expect((await view(editor.token)).body.document).toMatchObject({ role: 'editor', via_link: false });
    expect((await view(owner.token)).body.document).toMatchObject({ role: 'owner', via_link: false });
  });

  it('goes back to "not found" when the link is turned off', async () => {
    await setLinkAccess(owner.token, 'none');
    expect((await view()).status).toBe(404);
  });
});

describe('notifications for the collab server', () => {
  let listener;
  let messages;

  beforeEach(async () => {
    messages = [];
    listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    listener.on('notification', (msg) => messages.push(JSON.parse(msg.payload)));
    await listener.query(`LISTEN ${ACCESS_CHANNEL}`);
  });

  afterEach(() => listener.end());

  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('sends a link-only notice for every change of the link setting', async () => {
    await setLinkAccess(owner.token, 'viewer'); // off -> view
    await setLinkAccess(owner.token, 'editor'); // view -> edit
    await setLinkAccess(owner.token, 'viewer'); // edit -> view: link editors must lose their rights now
    await setLinkAccess(owner.token, 'none'); //   view -> off
    await settle();
    expect(messages).toEqual(Array(4).fill({ docId: doc.id, userId: null, linkOnly: true }));
  });

  it('sends nothing when nothing changed or the request is refused', async () => {
    await setLinkAccess(owner.token, 'none'); // already off
    await setLinkAccess(editor.token, 'none'); // refused
    await settle();
    expect(messages).toEqual([]);
  });
});
