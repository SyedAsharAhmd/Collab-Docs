import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ACCESS_CHANNEL } from '../src/accessEvents.js';
import { useTestServer } from './helpers.js';

const call = useTestServer();

async function registerUser(name) {
  const email = `${name.toLowerCase()}@example.com`;
  const { body } = await call('POST', '/register', { body: { name, email, password: 'password123' } });
  return { id: body.user.id, email, token: body.token };
}

let owner, bob, carol, doc;

beforeEach(async () => {
  owner = await registerUser('Owner');
  bob = await registerUser('Bob');
  carol = await registerUser('Carol');
  doc = (await call('POST', '/documents', { token: owner.token })).body.document;
});

const share = (token, email, role) =>
  call('POST', `/documents/${doc.id}/permissions`, { token, body: { email, role } });
const list = (token) => call('GET', `/documents/${doc.id}/permissions`, { token });
const remove = (token, userId) => call('DELETE', `/documents/${doc.id}/permissions/${userId}`, { token });

describe('sharing (owner only)', () => {
  it('shares by email, then lists collaborators with the owner first', async () => {
    const res = await share(owner.token, 'BOB@example.com', 'editor');
    expect(res.status).toBe(201);
    expect(res.body.collaborator).toMatchObject({ user_id: bob.id, email: bob.email, role: 'editor' });

    const { body } = await list(owner.token);
    expect(body.collaborators.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: owner.email, role: 'owner' },
      { email: bob.email, role: 'editor' },
    ]);
  });

  it('gives the new collaborator access, and the right role', async () => {
    await share(owner.token, bob.email, 'viewer');
    expect((await call('GET', `/documents/${doc.id}`, { token: bob.token })).body.document.role).toBe('viewer');
    expect((await call('PATCH', `/documents/${doc.id}`, { token: bob.token, body: { title: 'x' } })).status).toBe(403);
  });

  it('changes an existing role with 200', async () => {
    await share(owner.token, bob.email, 'viewer');
    const res = await share(owner.token, bob.email, 'editor');
    expect(res.status).toBe(200);
    expect(res.body.collaborator.role).toBe('editor');
  });

  it('rejects an unknown email, a bad role, and sharing with yourself', async () => {
    expect(await share(owner.token, 'nobody@example.com', 'editor')).toMatchObject({
      status: 404,
      body: { error: 'No account with that email' },
    });
    expect((await share(owner.token, bob.email, 'owner')).status).toBe(400);
    expect((await share(owner.token, owner.email, 'editor')).status).toBe(400);
  });

  it('removes a collaborator, who then gets 404', async () => {
    await share(owner.token, bob.email, 'editor');
    expect((await remove(owner.token, bob.id)).status).toBe(204);
    expect((await call('GET', `/documents/${doc.id}`, { token: bob.token })).status).toBe(404);
    expect((await remove(owner.token, bob.id)).status).toBe(404);
  });

  it('refuses to remove the owner', async () => {
    expect((await remove(owner.token, owner.id)).status).toBe(400);
  });

  it('gives editors and viewers 403, and strangers 404, on every sharing route', async () => {
    await share(owner.token, bob.email, 'editor');
    expect((await list(bob.token)).status).toBe(403);
    expect((await share(bob.token, carol.email, 'editor')).status).toBe(403);
    expect((await remove(bob.token, owner.id)).status).toBe(403);

    expect((await list(carol.token)).status).toBe(404);
    expect((await share(carol.token, carol.email, 'editor')).status).toBe(404);
  });
});

describe('access-change notifications for the collab server', () => {
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

  // NOTIFY is delivered asynchronously, so give it a moment.
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('notifies when a role changes or is removed, not when someone new is added', async () => {
    await share(owner.token, bob.email, 'editor');
    await settle();
    expect(messages).toEqual([]);

    await share(owner.token, bob.email, 'viewer');
    await remove(owner.token, bob.id);
    await settle();
    expect(messages).toEqual([
      { docId: doc.id, userId: bob.id },
      { docId: doc.id, userId: bob.id },
    ]);
  });

  it('notifies everyone (userId null) when the document is deleted', async () => {
    await call('DELETE', `/documents/${doc.id}`, { token: owner.token });
    await settle();
    expect(messages).toEqual([{ docId: doc.id, userId: null }]);
  });

  it('sends nothing when the change is refused', async () => {
    await share(owner.token, bob.email, 'editor');
    await remove(bob.token, owner.id); // 403
    await call('DELETE', `/documents/${doc.id}`, { token: bob.token }); // 403
    await settle();
    expect(messages).toEqual([]);
  });
});
