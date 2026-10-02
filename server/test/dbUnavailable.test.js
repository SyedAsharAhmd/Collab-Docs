import { afterEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { useTestServer } from './helpers.js';

const call = useTestServer();

afterEach(() => vi.restoreAllMocks());

// What pg throws when Postgres is down.
const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

function databaseDown() {
  vi.spyOn(pool, 'query').mockRejectedValue(refused());
  vi.spyOn(pool, 'connect').mockRejectedValue(refused());
  vi.spyOn(console, 'error').mockImplementation(() => {}); // expected logs
}

// A valid token doesn't need the database: only routes that query it should fail.
const token = jwt.sign({ sub: '00000000-0000-4000-8000-000000000000' }, process.env.JWT_SECRET, {
  algorithm: 'HS256',
  expiresIn: '1h',
});

it('answers 503 with a generic message, not 500, on every kind of route', async () => {
  databaseDown();
  const responses = [
    await call('POST', '/login', { body: { email: 'a@example.com', password: 'whatever1' } }),
    await call('GET', '/documents', { token }),
    await call('POST', '/documents', { token }), // uses a transaction (pool.connect)
  ];
  for (const res of responses) {
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/);
    expect(res.text).not.toMatch(/ECONNREFUSED|5432/); // no internals leak to the client
  }
});

it('still answers 500 for errors that are not about reachability', async () => {
  vi.spyOn(pool, 'query').mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await call('GET', '/documents', { token })).status).toBe(500);
});

it('recovers by itself once the database is back', async () => {
  databaseDown();
  expect((await call('GET', '/documents', { token })).status).toBe(503);
  vi.restoreAllMocks();
  expect((await call('GET', '/documents', { token })).status).toBe(200);
});
