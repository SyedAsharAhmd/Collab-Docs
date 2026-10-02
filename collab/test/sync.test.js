import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
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

// Pure Yjs: the property the whole design relies on.
describe('Yjs updates', () => {
  it('merge to the same result when duplicated and delivered out of order', () => {
    const source = new Y.Doc();
    const updates = [];
    source.on('update', (update) => updates.push(update));
    source.getText('t').insert(0, 'Hello');
    source.getText('t').insert(5, ' world');
    source.getText('t').delete(0, 1);
    source.getText('t').insert(0, 'J');

    const target = new Y.Doc();
    // Reversed, and every update delivered twice.
    for (const update of [...updates].reverse()) Y.applyUpdate(target, update);
    for (const update of updates) Y.applyUpdate(target, update);

    expect(target.getText('t').toString()).toBe('Jello world');
    expect(target.getText('t').toString()).toBe(source.getText('t').toString());
  });
});

describe('through the collab server', () => {
  let server, url, users, docId;

  beforeAll(applySchema);

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    users = [await createUser('u1'), await createUser('u2'), await createUser('u3')];
    docId = await createDocument(users[0]);
    await grant(docId, users[1], 'editor');
    await grant(docId, users[2], 'editor');
    ({ server, url } = await startServer());
  });

  afterEach(async () => {
    destroyProviders();
    await server?.destroy();
  });

  afterAll(() => pool.end());

  const text = (client) => client.ydoc.getText('t').toString();
  const allEqual = (clients) => clients.every((c) => text(c) === text(clients[0]));

  it('merges edits made on both sides while one client was offline', async () => {
    const a = await connect(url, docId, tokenFor(users[0]));
    const b = await connect(url, docId, tokenFor(users[1]));
    a.ydoc.getText('t').insert(0, 'shared ');
    await waitFor(() => text(b) === 'shared ');

    b.provider.disconnect(); // b loses its connection
    a.ydoc.getText('t').insert(7, 'online');
    b.ydoc.getText('t').insert(0, 'offline ');
    await new Promise((r) => setTimeout(r, 200));
    expect(text(b)).not.toContain('online'); // b really was cut off

    await b.provider.connect();
    await waitFor(() => allEqual([a, b]) && text(a).includes('online') && text(a).includes('offline'));
    expect(text(a)).toBe('offline shared online');
  });

  it('keeps three users identical when they type in the same paragraph at once', async () => {
    const clients = await Promise.all(users.map((u) => connect(url, docId, tokenFor(u))));
    // Each user inserts 20 characters, all at the start of the same text, without waiting.
    for (let i = 0; i < 20; i++) {
      clients.forEach((client, n) => client.ydoc.getText('t').insert(0, String(n + 1)));
    }
    await waitFor(() => allEqual(clients) && text(clients[0]).length === 60, 5000);
    for (const n of ['1', '2', '3']) expect(text(clients[0]).split(n)).toHaveLength(21); // 20 of each
  });

  it('keeps up with rapid typing', async () => {
    const a = await connect(url, docId, tokenFor(users[0]));
    const b = await connect(url, docId, tokenFor(users[1]));
    const typed = 'The quick brown fox jumps over the lazy dog. '.repeat(20); // 900 keystrokes
    for (const char of typed) a.ydoc.getText('t').insert(text(a).length, char);
    await waitFor(() => text(b) === typed, 5000);
  });

  it('syncs and stores a large paste', async () => {
    const a = await connect(url, docId, tokenFor(users[0]));
    const b = await connect(url, docId, tokenFor(users[1]));
    const pasted = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4000); // ~228 KB
    a.ydoc.getText('t').insert(0, pasted);
    await waitFor(() => text(b).length === pasted.length, 5000);
    expect(text(b)).toBe(pasted);

    a.provider.destroy();
    b.provider.destroy();
    await waitFor(async () => {
      const { rows } = await pool.query('SELECT ydoc_state FROM documents WHERE id = $1', [docId]);
      if (!rows[0].ydoc_state) return false;
      const stored = new Y.Doc();
      Y.applyUpdate(stored, rows[0].ydoc_state);
      return stored.getText('t').toString() === pasted;
    }, 5000);
  });

  it('reconnects by itself after a server restart and syncs edits made while it was down', async () => {
    const port = server.address.port;
    const a = await connect(url, docId, tokenFor(users[0]));
    a.ydoc.getText('t').insert(0, 'before restart');
    await waitFor(() => server.hocuspocus.documents.get(docId)?.getText('t').toString() === 'before restart');

    // A restart: graceful shutdown (stores the document), then the process exits.
    await server.destroy();
    server.killSockets();
    await waitFor(() => a.provider.configuration.websocketProvider.status === 'disconnected');
    a.ydoc.getText('t').insert(text(a).length, ', typed while down'); // client keeps editing offline

    ({ server } = await startServer({ port })); // same address

    // No reconnect call: the provider retries on its own.
    await waitFor(
      () => server.hocuspocus.documents.get(docId)?.getText('t').toString() === 'before restart, typed while down',
      15000,
    );
  }, 20000); // the provider's reconnect backs off for a few seconds
});
