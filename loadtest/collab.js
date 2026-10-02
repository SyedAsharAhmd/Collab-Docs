// Collab server load test: many users typing in many documents at once.
// Measures how long an edit takes to reach the other users in the same document,
// whether every copy ends up identical, and whether everything is saved to Postgres.
//
// Usage: npm run collab            (default levels)
//        npm run collab -- 20x5,80x5  (documents x users per document)
import { monitorEventLoopDelay } from 'node:perf_hooks';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { JWT_SECRET, measureServer, ms, percentile, pool, resetDatabase, sleep, startServer } from './common.js';

const PORT = 1434;
const URL_WS = `ws://127.0.0.1:${PORT}`;
const TYPING_INTERVAL_MS = 200; // 5 keystrokes a second per user: a fast typist
const DURATION_MS = 20000;
const LEVELS = (process.argv[2] ?? '10x5,50x5,100x5,200x5').split(',').map((level) => {
  const [docs, usersPerDoc] = level.split('x').map(Number);
  return { docs, usersPerDoc };
});

await resetDatabase();
const collab = await startServer({ dir: 'collab', env: { PORT: String(PORT) }, readyUrl: `http://127.0.0.1:${PORT}` });

// Users and documents are written straight to the database: this test is about the
// collab server, not about registering through the API.
async function seed({ docs, usersPerDoc }) {
  await pool.query('TRUNCATE users CASCADE');
  const { rows: users } = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     SELECT 'load' || n || '@example.com', 'not-a-real-hash', 'Load ' || n FROM generate_series(1, $1) n
     RETURNING id`,
    [usersPerDoc],
  );
  const { rows: documents } = await pool.query(
    'INSERT INTO documents (owner_id) SELECT $1 FROM generate_series(1, $2) RETURNING id',
    [users[0].id, docs],
  );
  const userIds = users.map((u) => u.id);
  const docIds = documents.map((d) => d.id);
  await pool.query(
    `INSERT INTO permissions (doc_id, user_id, role)
     SELECT d, u, CASE WHEN u = $3 THEN 'owner' ELSE 'editor' END
       FROM unnest($1::uuid[]) d CROSS JOIN unnest($2::uuid[]) u`,
    [docIds, userIds, userIds[0]],
  );
  const tokens = userIds.map((id) => jwt.sign({ sub: id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }));
  return { docIds, tokens };
}

// Connects one simulated browser tab and resolves when it has synced (or failed).
function connectClient(docId, token) {
  const client = { docId, ydoc: new Y.Doc(), sent: 0, failed: null, started: performance.now() };
  return new Promise((resolve) => {
    const done = () => resolve(client);
    client.provider = new HocuspocusProvider({
      url: URL_WS,
      name: docId,
      document: client.ydoc,
      token,
      onSynced: () => {
        client.connectMs = performance.now() - client.started;
        done();
      },
      onAuthenticationFailed: ({ reason }) => {
        client.failed = reason;
        done();
      },
    });
    setTimeout(() => {
      client.failed ??= 'timeout';
      done();
    }, 30000);
  });
}

async function runLevel(level) {
  const { docIds, tokens } = await seed(level);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });

  // Connect 50 at a time, like a crowd arriving rather than all in the same millisecond.
  const pending = docIds.flatMap((docId) => tokens.map((token) => ({ docId, token })));
  const clients = [];
  for (let i = 0; i < pending.length; i += 50) {
    clients.push(...(await Promise.all(pending.slice(i, i + 50).map(({ docId, token }) => connectClient(docId, token)))));
  }
  const connected = clients.filter((c) => !c.failed);

  // Each edit also stamps the sender's clock into a shared map. Receivers in the same
  // document compute "now - stamp": the time from keystroke to arrival (same machine,
  // so the clocks agree).
  const latencies = [];
  for (const client of connected) {
    const stamps = client.ydoc.getMap('stamps');
    stamps.observe((event) => {
      if (event.transaction.local) return;
      const now = Date.now();
      for (const key of event.keysChanged) latencies.push(now - stamps.get(key));
    });
  }

  const typed = await measureServer(collab, async () => {
    loopDelay.enable();
    const timers = connected.map((client) => {
      const key = String(client.ydoc.clientID);
      const text = client.ydoc.getText('t');
      const stamps = client.ydoc.getMap('stamps');
      const type = () => {
        client.ydoc.transact(() => {
          text.insert(text.length, 'x');
          stamps.set(key, Date.now());
        });
        client.sent++;
      };
      // Random start, so 1000 users don't all press a key in the same millisecond.
      return setTimeout(() => (client.interval = setInterval(type, TYPING_INTERVAL_MS)), Math.random() * TYPING_INTERVAL_MS);
    });
    await sleep(DURATION_MS);
    timers.forEach(clearTimeout);
    connected.forEach((client) => clearInterval(client.interval));
    loopDelay.disable();
    return {};
  });

  // Converged = every copy of a document holds exactly the same text, containing every
  // keystroke anyone sent.
  const byDoc = Map.groupBy(connected, (c) => c.docId);
  const expectedLength = (copies) => copies.reduce((sum, c) => sum + c.sent, 0);
  const isConverged = (copies) => {
    const first = copies[0].ydoc.getText('t').toString();
    return first.length === expectedLength(copies) && copies.every((c) => c.ydoc.getText('t').toString() === first);
  };
  const deadline = Date.now() + 15000;
  let converged = 0;
  while (Date.now() < deadline) {
    converged = [...byDoc.values()].filter(isConverged).length;
    if (converged === byDoc.size) break;
    await sleep(250);
  }

  // Everyone leaves: each document is stored on the last disconnect. Check Postgres.
  const finalText = new Map([...byDoc].map(([docId, copies]) => [docId, copies[0].ydoc.getText('t').toString()]));
  clients.forEach((c) => c.provider.destroy());
  let persisted = 0;
  const saveDeadline = Date.now() + 20000;
  while (Date.now() < saveDeadline) {
    const { rows } = await pool.query('SELECT id, ydoc_state FROM documents WHERE id = ANY($1)', [docIds]);
    persisted = rows.filter((row) => {
      if (!row.ydoc_state) return false;
      const stored = new Y.Doc();
      Y.applyUpdate(stored, row.ydoc_state);
      return stored.getText('t').toString() === finalText.get(row.id);
    }).length;
    if (persisted === docIds.length) break;
    await sleep(500);
  }
  await sleep(1000); // let the server unload the documents before the next level

  const sent = connected.reduce((sum, c) => sum + c.sent, 0);
  return {
    level: `${level.docs} docs x ${level.usersPerDoc} users`,
    connections: clients.length,
    'connect fails': clients.length - connected.length,
    'connect p95 ms': ms(percentile(connected.map((c) => c.connectMs), 95)),
    'edits/s': Math.round(sent / (DURATION_MS / 1000)),
    'deliveries/s': Math.round(latencies.length / (DURATION_MS / 1000)),
    'latency p50 ms': percentile(latencies, 50),
    'latency p95 ms': percentile(latencies, 95),
    'latency p99 ms': percentile(latencies, 99),
    'latency max ms': latencies.reduce((max, v) => (v > max ? v : max), 0),
    converged: `${converged}/${byDoc.size}`,
    'saved to DB': `${persisted}/${docIds.length}`,
    ...Object.fromEntries(Object.entries(typed).filter(([key]) => key.startsWith('server'))),
    // If this is high, the load generator itself was struggling, and the latencies
    // above include its delay too.
    'generator lag p99 ms': ms(loopDelay.percentile(99) / 1e6),
  };
}

try {
  const results = [];
  for (const level of LEVELS) {
    console.log(`Level: ${level.docs} documents x ${level.usersPerDoc} users, typing for ${DURATION_MS / 1000} s…`);
    results.push(await runLevel(level));
    console.log(results.at(-1));
  }
  console.table(results);
  if (collab.errorLines.length) console.log(`Server logged ${collab.errorLines.length} error line(s), e.g.:`, collab.errorLines.slice(0, 3));
} finally {
  collab.kill();
  await pool.end();
}
