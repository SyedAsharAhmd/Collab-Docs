import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { useTestServer } from './helpers.js';

const call = useTestServer();

const ada = { email: 'Ada@Example.com', password: 'correct horse', name: 'Ada' };
const register = (user = ada) => call('POST', '/register', { body: user });

describe('POST /register', () => {
  it('creates a user and returns a token', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ id: expect.any(String), email: 'ada@example.com', name: 'Ada' });
  });

  it('stores a bcrypt hash, never the password', async () => {
    await register();
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(rows[0].password_hash).not.toContain(ada.password);
  });

  it('returns 400 for a bad email or short password', async () => {
    expect((await register({ ...ada, email: 'not-an-email' })).status).toBe(400);
    expect((await register({ ...ada, password: 'short' })).status).toBe(400);
  });

  it('returns 409 for a duplicate email, ignoring case', async () => {
    await register();
    const res = await register({ ...ada, email: 'ADA@example.com' });
    expect(res.status).toBe(409);
  });
});

describe('POST /login', () => {
  beforeEach(() => register());

  it('returns a token for correct credentials', async () => {
    const res = await call('POST', '/login', { body: { email: 'ada@example.com', password: ada.password } });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.email).toBe('ada@example.com');
  });

  it('gives the identical response for a wrong password and an unknown email', async () => {
    const wrongPassword = await call('POST', '/login', { body: { email: ada.email, password: 'wrong password' } });
    const unknownEmail = await call('POST', '/login', { body: { email: 'nobody@example.com', password: 'whatever1' } });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.text).toBe(unknownEmail.text);
  });
});

describe('GET /me', () => {
  it('returns the user for a valid token', async () => {
    const { body } = await register();
    const res = await call('GET', '/me', { token: body.token });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(body.user);
  });

  it('returns 401 without a token, with a garbage token, or with a bad signature', async () => {
    const { body } = await register();
    const forged = jwt.sign({ sub: body.user.id }, 'some-other-secret');
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'garbage' })).status).toBe(401);
    expect((await call('GET', '/me', { token: forged })).status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const { body } = await register();
    const expired = jwt.sign(
      { sub: body.user.id, exp: Math.floor(Date.now() / 1000) - 10 },
      process.env.JWT_SECRET,
    );
    expect((await call('GET', '/me', { token: expired })).status).toBe(401);
  });

  it('returns 401 if the user was deleted after the token was issued', async () => {
    const { body } = await register();
    await pool.query('DELETE FROM users');
    expect((await call('GET', '/me', { token: body.token })).status).toBe(401);
  });
});

it('never includes password_hash in any auth response', async () => {
  const reg = await register();
  const login = await call('POST', '/login', { body: ada });
  const me = await call('GET', '/me', { token: reg.body.token });
  for (const res of [reg, login, me]) expect(res.text).not.toMatch(/password/i);
});
