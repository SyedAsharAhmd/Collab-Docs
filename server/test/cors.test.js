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
  // Every method the API uses must be listed, or the browser blocks it before it is sent.
  // (PUT was once missing, which broke the link sharing switch on the deployed site.)
  expect(res.headers.get('access-control-allow-methods').split(', ')).toEqual(
    expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  );
});

it('gives any other origin no CORS headers, so the browser blocks it', async () => {
  const res = await preflight('https://evil.example.com');
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
});
