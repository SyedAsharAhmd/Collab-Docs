// Load test for link sharing: many visitors who are not logged in.
//   A. one document, a few real editors typing, many anonymous visitors watching it
//   B. many documents, anonymous visitors typing (link set to "edit")
//   C. the cap on visitors per document
// Usage: npm run anon
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { JWT_SECRET, measureServer, ms, percentile, pool, resetDatabase, sleep, startServer } from './common.js';

const PORT = 1634;
const URL_WS = `ws://127.0.0.1:${PORT}`;
const TYPING_INTERVAL_MS = 200; // 5 keystrokes a second per typist
const DURATION_MS = 15000;

await resetDatabase();
const collab = await startServer({ dir: 'collab', env: { PORT: String(PORT) }, readyUrl: `http://127.0.0.1:${PORT}` });

// Users and documents go straight into the database: this tests the collab server.
async function seed({ docs, users, linkAccess }) {
  await pool.query('TRUNCATE users CASCADE');
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (email, password_hash, name)
     SELECT 'load' || n || '@example.com', 'not-a-real-hash', 'Load ' || n FROM generate_series(1, $1) n RETURNING id`,
    [users],
  );
  const userIds = userRows.map((u) => u.id);
  const { rows: docRows } = await pool.query(
    "INSERT INTO documents (owner_id, link_access) SELECT $1, $3 FROM generate_series(1, $2) RETURNING id",
    [userIds[0], docs, linkAccess],
  );
  const docIds = docRows.map((d) => d.id);
  await pool.query(
    `INSERT INTO permissions (doc_id, user_id, role)
     SELECT d, u, CASE WHEN u = $3 THEN 'owner' ELSE 'editor' END
       FROM unnest($1::uuid[]) d CROSS JOIN unnest($2::uuid[]) u`,
    [docIds, userIds, userIds[0]],
  );
  const tokens = userIds.map((id) => jwt.sign({ sub: id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }));
  return { docIds, tokens };
}

function connectClient(docId, token, role) {
  const client = { docId, role, ydoc: new Y.Doc(), sent: 0, failed: null, started: performance.now() };
  return new Promise((resolve) => {
    client.provider = new HocuspocusProvider({
      url: URL_WS,
      name: docId,
      document: client.ydoc,
      token,
      onSynced: () => {
        client.connectMs = performance.now() - client.started;
        resolve(client);
      },
      onAuthenticationFailed: ({ reason }) => {
        client.failed = reason;
        resolve(client);
      },
    });
    setTimeout(() => {
      client.failed ??= 'timeout';
      resolve(client);
    }, 30000);
  });
}

async function connectAll(specs) {
  const clients = [];
  for (let i = 0; i < specs.length; i += 50) {
    clients.push(...(await Promise.all(specs.slice(i, i + 50).map((s) => connectClient(s.docId, s.token, s.role)))));
  }
  return clients;
}

// Typists type and stamp the time; everyone else measures how long that took to arrive.
async function typeAndMeasure(clients) {
  const connected = clients.filter((c) => !c.failed);
  const latencies = []; // only for watchers
  for (const client of connected) {
    const stamps = client.ydoc.getMap('stamps');
    stamps.observe((event) => {
      if (event.transaction.local || client.role !== 'watcher') return;
      const now = Date.now();
      for (const key of event.keysChanged) latencies.push(now - stamps.get(key));
    });
  }
  const typed = await measureServer(collab, async () => {
    const timers = connected
      .filter((c) => c.role === 'typist')
      .map((client) => {
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
        return setTimeout(() => (client.interval = setInterval(type, TYPING_INTERVAL_MS)), Math.random() * TYPING_INTERVAL_MS);
      });
    await sleep(DURATION_MS);
    timers.forEach(clearTimeout);
    connected.forEach((c) => clearInterval(c.interval));
    return {};
  });

  // Converged: every copy of a document holds the same text, with every keystroke in it.
  const byDoc = Map.groupBy(connected, (c) => c.docId);
  const isConverged = (copies) => {
    const first = copies[0].ydoc.getText('t').toString();
    const sent = copies.reduce((sum, c) => sum + c.sent, 0);
    return first.length === sent && copies.every((c) => c.ydoc.getText('t').toString() === first);
  };
  let converged = 0;
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await sleep(250)) {
    converged = [...byDoc.values()].filter(isConverged).length;
    if (converged === byDoc.size) break;
  }
  return { latencies, converged: `${converged}/${byDoc.size}`, typed, edits: connected.reduce((s, c) => s + c.sent, 0) };
}

const rows = [];
const summary = (label, clients, r) => ({
  scenario: label,
  connections: clients.length,
  'connect fails': clients.filter((c) => c.failed).length,
  'edits/s': Math.round(r.edits / (DURATION_MS / 1000)),
  'watcher p50 ms': r.latencies.length ? percentile(r.latencies, 50) : '-',
  'watcher p95 ms': r.latencies.length ? percentile(r.latencies, 95) : '-',
  'watcher max ms': r.latencies.length ? r.latencies.reduce((m, v) => (v > m ? v : m), 0) : '-',
  converged: r.converged,
  'server CPU % avg': r.typed['server CPU % avg'],
  'server MB max': r.typed['server MB max'],
});

try {
  // A. one document, 5 real editors, V anonymous watchers
  for (const watchers of [10, 50, 100]) {
    console.log(`A: 1 document, 5 editors typing, ${watchers} visitors watching…`);
    const { docIds, tokens } = await seed({ docs: 1, users: 5, linkAccess: 'viewer' });
    const specs = [
      ...tokens.map((token) => ({ docId: docIds[0], token, role: 'typist' })),
      ...Array.from({ length: watchers }, () => ({ docId: docIds[0], token: '', role: 'watcher' })),
    ];
    const clients = await connectAll(specs);
    const r = await typeAndMeasure(clients);
    rows.push(summary(`A: 5 editors + ${watchers} visitors watching`, clients, r));
    clients.forEach((c) => c.provider.destroy());
    await sleep(1500);
  }

  // B. visitors typing: D documents x 5 anonymous editors
  for (const docs of [20, 100]) {
    console.log(`B: ${docs} documents x 5 anonymous editors typing…`);
    const { docIds } = await seed({ docs, users: 1, linkAccess: 'editor' });
    const specs = docIds.flatMap((docId) => Array.from({ length: 5 }, () => ({ docId, token: '', role: 'typist' })));
    const clients = await connectAll(specs);
    const r = await typeAndMeasure(clients);
    rows.push({ ...summary(`B: ${docs} docs x 5 visitors typing`, clients, r), 'watcher p50 ms': '-', 'watcher p95 ms': '-', 'watcher max ms': '-' });
    clients.forEach((c) => c.provider.destroy());
    await sleep(1500);
  }

  console.table(rows);

  // C. the cap on visitors per document (default 100): 120 try, 100 get in, a real editor still can
  console.log('C: 120 visitors try to open one document…');
  const { docIds, tokens } = await seed({ docs: 1, users: 2, linkAccess: 'viewer' });
  // The collab server uses its default cap here: 100 visitors per document.
  const visitors = await connectAll(Array.from({ length: 120 }, () => ({ docId: docIds[0], token: '', role: 'watcher' })));
  const admitted = visitors.filter((c) => !c.failed).length;
  const refused = visitors.filter((c) => c.failed === 'too-many-viewers').length;
  const realEditor = await connectClient(docIds[0], tokens[1], 'typist');
  console.log(`   admitted ${admitted}, refused with too-many-viewers ${refused}, other failures ${120 - admitted - refused}`);
  console.log(`   a real editor still gets in while the visitor cap is full: ${!realEditor.failed}`);
  visitors.forEach((c) => c.provider.destroy());
  realEditor.provider.destroy();

  if (collab.errorLines.length) console.log(`Server logged ${collab.errorLines.length} error line(s), e.g.:`, collab.errorLines.slice(0, 3));
  else console.log('Server logged no errors.');
} finally {
  collab.kill();
  await pool.end();
}
