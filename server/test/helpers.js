import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is not set. Add it to server/.env (see .env.example).');
}

// Creates the tables if they don't exist. Every test file must call this (directly or
// through useTestServer): files run in any order, and CI starts from an empty database.
export const applySchema = async () =>
  pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

// Registers hooks that start the app on a random port and empty the tables before
// every test. Returns `call`, which sends a JSON request and parses the response.
export function useTestServer() {
  let server;
  let base;

  beforeAll(async () => {
    await applySchema();
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

  // `headers` adds raw headers (e.g. a malformed Authorization value) beyond the Bearer token.
  return async function call(method, path, { body, token, headers: extraHeaders } = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
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
