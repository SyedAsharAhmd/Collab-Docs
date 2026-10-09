# Load tests

Local load tests for the REST API (`rest.js`) and the collab server (`collab.js`). Each
script starts the server under test as a separate process, on its own port, against the
**test** database (`TEST_DATABASE_URL` in `server/.env`), which it wipes.

```
cd loadtest
npm install
npm run rest
npm run collab                 # default levels: 10x5,50x5,100x5,200x5
npm run collab -- 20x5,80x5    # documents x users per document
```

They are not run in CI, and never against the deployed site: numbers from shared free
hosting would be meaningless, and the load would disrupt the live demo.

## Results (2026-10-02)

One Windows laptop, Node 24, local Postgres 18. The load generator and the server share
the same machine, so treat the numbers as relative, not as production capacity.

### Collab server

Every simulated user types continuously at 5 keystrokes per second (a fast typist, far
above a real user's average), in documents of 5 users each.

| Connections | Edits/s | Latency p50 | p95 | p99 | Converged | Saved to DB | Server CPU (one core) | Memory |
|---|---|---|---|---|---|---|---|---|
| 50 | 244 | 4 ms | 11 ms | 15 ms | 10/10 | 10/10 | 20% | 95 MB |
| 250 | 1,181 | 13 ms | 70 ms | 132 ms | 50/50 | 50/50 | 58% | 135 MB |
| 500 | 2,176 | 84 ms | 178 ms | 211 ms | 100/100 | 100/100 | 79% | 206 MB |
| 1,000 | 3,098* | 864 ms | 1.9 s | 2.2 s | 200/200 | 200/200 | 95% | 271 MB |

Latency = time from one user's keystroke to it appearing for the others in the document.

\* 1,000 users should send 5,000 edits/s; the generator only managed 3,098 (its own event
loop lagged 344 ms at p99), so that row is limited by the test machine as much as the server.

**Findings**

- **Correctness held at every level**: no failed connections, every copy of every
  document identical, and every document saved to Postgres.
- **The limit is one CPU core.** Node runs JavaScript on a single thread; around 500
  nonstop typists it is busy most of the time, and at 1,000 edits queue up and latency
  grows to seconds. Real users type in bursts and mostly read, so real capacity is higher.
- **Scaling past one server** needs all users of a document on the same instance
  (sticky routing by document id) or instances sharing updates (Redis pub/sub); see the
  project README.

### REST API

| Scenario | Concurrent users | Req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|---|
| GET /documents | 1 | 579 | 1.4 ms | 3.6 ms | 4.3 ms | 0 |
| GET /documents | 10 | 1,649 | 5.5 ms | 8.8 ms | 12.7 ms | 0 |
| GET /documents | 50 | 1,383 | 34 ms | 51 ms | 62 ms | 0 |
| GET /documents | 100 | 1,428 | 64 ms | 119 ms | 127 ms | 0 |
| POST /login | 1 | 3 | 311 ms | 700 ms | 702 ms | 0 |
| POST /login | 10 | 3 | 4.2 s | 6.2 s | 7.4 s | 0 |
| POST /login | 50 | 5 | 18 s | 18.1 s | 18.1 s | 1 |

**Findings**

- Ordinary requests peak around **1,400–1,650 per second**, limited by the one CPU core;
  beyond that, extra users just wait in line (latency grows, throughput stays flat).
- **Login handles only ~3 per second.** bcrypt at cost 12 is deliberately slow (~300 ms),
  and `bcryptjs` is pure JavaScript, so it runs on the same thread as every other request.
  Under 50 simultaneous logins, other work starved: one request's database connection
  timed out. With no rate limiting, anyone could also try passwords as fast as the server
  allowed.

### After adding rate limiting

`/login` and `/register` are now limited to 20 attempts per minute per IP, and `/login`
to 5 attempts per 15 minutes per email (see `server/src/routes/auth.js`). Both checks
run before bcrypt, so a rejected attempt costs almost nothing.

| Scenario | Concurrent | Requests | Rejected with 429 | p50 | p95 |
|---|---|---|---|---|---|
| Login flood, wrong password | 50 | 32,018 | 32,013 | 11.6 ms | 25.9 ms |
| GET /documents during the flood | 10 | 4,896 | 0 | 15.5 ms | 31.1 ms |

Only 5 attempts reached bcrypt (the per-email limit), each answered 401. Users listing
documents during the flood stayed fast, where before the fix 50 simultaneous logins made
requests take 18 s. The load generator is a single client here; a flood spread over many
IPs (a botnet) is beyond what an app-level limit can stop, and is a job for the hosting
provider's DDoS protection.

## Link sharing: visitors who are not logged in

`npm run anon` (results from the same laptop, 2026-10-09). Visitors are anonymous
WebSocket connections with no token, typing or watching through "anyone with the link".

| Scenario | Connections | Edit reaches a watcher (p50 / p95) | All copies identical | Server CPU |
|---|---|---|---|---|
| 5 editors typing, 10 visitors watching one document | 15 | 4 ms / 7 ms | yes | 7% |
| 5 editors typing, 50 visitors watching | 55 | 7 ms / 17 ms | yes | 10% |
| 5 editors typing, 100 visitors watching | 105 | 10 ms / 21 ms | yes | 10% |
| 100 documents, 5 visitors typing in each (link set to edit) | 500 | not measured | yes, 100 of 100 | 47% |

Visitors cost the server about the same as logged-in users, which is expected: the only
difference is one extra permission query when they connect.

**The cap:** at most 100 visitors can be connected through the link to one document at a
time (`MAX_LINK_VIEWERS`). With 120 trying, 100 got in and 20 were refused with
`too-many-viewers`, and a logged-in collaborator could still open the document.

Every refused connection is logged by Hocuspocus as `[onAuthenticate] <reason>`, so someone
without an account can add log lines just by being refused. The server handled this
without trouble, but if it became a nuisance, the fix would be to rate limit by IP at the
hosting layer.
