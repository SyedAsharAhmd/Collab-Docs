import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { RateLimiter } from '../src/rateLimit.js';
import { applySchema } from './helpers.js';

describe('RateLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('allows `limit` hits per window, then reports the wait, then resets', () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });
    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.retryAfter('a')).toBe(60);
    expect(limiter.retryAfter('b')).toBe(0); // keys are independent

    vi.advanceTimersByTime(45_000);
    expect(limiter.retryAfter('a')).toBe(15);
    vi.advanceTimersByTime(15_000);
    expect(limiter.retryAfter('a')).toBe(0); // new window
  });
});

describe('login and register limits', () => {
  // Small limits so the tests stay fast. One server per scenario, so counts don't leak.
  const limits = { perIp: { limit: 6, windowMs: 60_000 }, perEmail: { limit: 3, windowMs: 60_000 } };
  const servers = [];
  const password = 'password123';
  const stamp = Date.now();

  beforeAll(async () => {
    await applySchema();
    await pool.query("DELETE FROM users WHERE email LIKE 'ratelimit-%'");
  });
  afterAll(async () => {
    servers.forEach((s) => s.close());
    await pool.query("DELETE FROM users WHERE email LIKE 'ratelimit-%'");
    await pool.end();
  });

  function startApp(options = {}) {
    const server = createApp({ authLimits: limits, ...options }).listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    return (path, body, headers = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
  }

  it('locks an email after too many attempts, even with the right password, and tells when to retry', async () => {
    const post = startApp();
    const email = `ratelimit-a-${stamp}@example.com`;
    expect((await post('/register', { name: 'A', email, password })).status).toBe(201);

    for (let i = 0; i < 3; i++) expect((await post('/login', { email, password: 'wrong-guess' })).status).toBe(401);
    const locked = await post('/login', { email, password });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await locked.json()).error).toMatch(/Too many attempts/);
  });

  it('gives an unknown email exactly the same answers, so the limit reveals nothing', async () => {
    const post = startApp();
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post('/login', { email: `ratelimit-nobody-${stamp}@example.com`, password })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  it('clears the email count after a successful login', async () => {
    const post = startApp();
    const email = `ratelimit-b-${stamp}@example.com`;
    await post('/register', { name: 'B', email, password });
    await post('/login', { email, password: 'wrong-guess' });
    await post('/login', { email, password: 'wrong-guess' });
    expect((await post('/login', { email, password })).status).toBe(200);
    // Two more mistakes are allowed again (they'd be the 3rd and 4th without the reset).
    expect((await post('/login', { email, password: 'wrong-guess' })).status).toBe(401);
    expect((await post('/login', { email, password: 'wrong-guess' })).status).toBe(401);
  });

  it('limits attempts per IP across different emails, register included', async () => {
    const post = startApp();
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const email = `ratelimit-ip-${i}-${stamp}@example.com`;
      statuses.push((await post(i % 2 ? '/login' : '/register', { name: 'C', email, password })).status);
    }
    expect(statuses.slice(0, 6)).not.toContain(429);
    expect(statuses[6]).toBe(429);
  });

  it('counts parallel attempts on one email immediately, not after bcrypt finishes', async () => {
    const post = startApp();
    const email = `ratelimit-c-${stamp}@example.com`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post('/login', { email, password: 'wrong-guess' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([401, 401, 401, 429, 429]);
  });

  it('behind a proxy, limits the real client IP and ignores IPs the client invents', async () => {
    // One trusted proxy. A real proxy appends the address it saw, so the header arrives
    // as "<whatever the client wrote>, <real client IP>". Only the last entry counts.
    const post = startApp({ trustProxyHops: 1 });
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const email = `ratelimit-proxy-${i}-${stamp}@example.com`;
      // The client invents a fresh IP each time; the proxy-added part stays the same.
      const forwarded = `10.0.0.${i}, 203.0.113.5`;
      statuses.push((await post('/login', { email, password }, { 'X-Forwarded-For': forwarded })).status);
    }
    expect(statuses[6]).toBe(429);
  });

  it('without a trusted proxy, ignores X-Forwarded-For completely', async () => {
    const post = startApp(); // trustProxyHops 0 locally: the socket address is the client
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const email = `ratelimit-direct-${i}-${stamp}@example.com`;
      statuses.push((await post('/login', { email, password }, { 'X-Forwarded-For': `10.0.1.${i}` })).status);
    }
    expect(statuses[6]).toBe(429);
  });
});
