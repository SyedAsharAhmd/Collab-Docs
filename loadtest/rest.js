// REST API load test: how many requests per second, and how fast, as concurrency grows.
// Usage: npm run rest
import { measureServer, ms, percentile, pool, resetDatabase, startServer } from './common.js';

const PORT = 3201;
const BASE = `http://localhost:${PORT}/api`;
const DURATION_MS = 10000;
const PASSWORD = 'password123';

await resetDatabase();
const api = await startServer({
  dir: 'server',
  env: { PORT: String(PORT), CLIENT_ORIGIN: 'http://localhost' },
  readyUrl: `${BASE}/me`,
});

// Sends requests from `concurrency` simultaneous users for DURATION_MS.
async function run(scenario, concurrency, request) {
  const latencies = [];
  let errors = 0;
  let limited = 0; // 429 Too Many Requests: rejected on purpose, not a failure
  const end = Date.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < end) {
        const start = performance.now();
        try {
          const res = await request();
          await res.arrayBuffer();
          if (res.status === 429) limited++;
          else if (!res.ok) errors++;
        } catch {
          errors++;
        }
        latencies.push(performance.now() - start);
      }
    }),
  );
  return {
    scenario,
    concurrency,
    requests: latencies.length,
    'req/s': Math.round(latencies.length / (DURATION_MS / 1000)),
    'p50 ms': ms(percentile(latencies, 50)),
    'p95 ms': ms(percentile(latencies, 95)),
    'p99 ms': ms(percentile(latencies, 99)),
    'rate-limited (429)': limited,
    errors,
  };
}

try {
  const email = 'load@example.com';
  const registered = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Load', email, password: PASSWORD }),
  }).then((res) => res.json());
  const auth = { Authorization: `Bearer ${registered.token}` };
  for (let i = 0; i < 20; i++) {
    await fetch(`${BASE}/documents`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  }

  const results = [];
  for (const concurrency of [1, 10, 50, 100]) {
    console.log(`GET /documents with ${concurrency} concurrent users…`);
    results.push(
      await measureServer(api, () =>
        run('GET /documents (list, DB query)', concurrency, () => fetch(`${BASE}/documents`, { headers: auth })),
      ),
    );
  }
  // A login flood from one machine, while 10 other users keep listing documents.
  // Before rate limiting, the flood's bcrypt work starved everything else.
  console.log('POST /login flood (50 concurrent) while 10 users list documents…');
  const loginRequest = () =>
    fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-guess' }),
    });
  const during = await measureServer(api, async () => {
    const [flood, listing] = await Promise.all([
      run('POST /login flood (wrong password)', 50, loginRequest),
      run('GET /documents during the flood', 10, () => fetch(`${BASE}/documents`, { headers: auth })),
    ]);
    return { flood, listing };
  });
  const { flood, listing, ...serverStats } = during;
  results.push({ ...flood, ...serverStats }, { ...listing, ...serverStats });
  console.table(results);
  if (api.errorLines.length) console.log(`Server logged ${api.errorLines.length} error line(s), e.g.:`, api.errorLines.slice(0, 3));
} finally {
  api.kill();
  await pool.end();
}
