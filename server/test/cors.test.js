import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const CLIENT = 'https://client.example.com';
let server;
let base;

beforeAll(() => {
  server = createApp({ clientOrigin: CLIENT }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(() => server?.close());

const preflight = (origin) =>
  fetch(`${base}/documents`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });

it('allows the client origin, including the Authorization header', async () => {
  const res = await preflight(CLIENT);
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe(CLIENT);
  expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
});

it('gives any other origin no CORS headers, so the browser blocks it', async () => {
  const res = await preflight('https://evil.example.com');
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
});
