import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Add it to server/.env (see .env.example).');
}

// Registers hooks that start the app on a random port and empty the tables before
// every test. Returns `call`, which sends a JSON request and parses the response.
export function useTestServer() {
  let server;
  let base;

  beforeAll(async () => {
    await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    // Tests register and log in far faster than any person; rate limiting has its own tests.
    const unlimited = { limit: Infinity, windowMs: 60_000 };
    server = createApp({ authLimits: { perIp: unlimited, perEmail: unlimited } }).listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  // Cascades to documents and permissions.
  beforeEach(() => pool.query('TRUNCATE users CASCADE'));

  afterAll(async () => {
    server?.close();
    await pool.end();
  });

  return async function call(method, path, { body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
}
