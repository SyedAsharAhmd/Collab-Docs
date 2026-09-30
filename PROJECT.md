# Real-Time Collaborative Document Editor (Google Docs Clone)

## Goal

Build a web app where multiple logged-in users edit the same rich-text document at the same time and see each other's changes live. This is a learning and portfolio project that will be tested heavily and must be defended in front of a senior engineer. **Correctness, security, and clarity matter more than feature count.** The owner must be able to explain every part.

**Core MVP:** authentication -> documents -> rich text -> real-time collaboration -> persistence -> permissions -> deployment.

## Constraints (do not deviate without asking)

- **Language:** JavaScript (ES modules) on Node.js LTS. No TypeScript unless asked.
- **Frontend:** React + Vite. **No Next.js** (no SSR/SEO need).
- **Editor:** Tiptap (ProseMirror). Real-time sync with **Yjs**. **Never implement your own CRDT or OT.**
- **Two separate server processes**, same repo:
  - `server/`: Express REST API (register, login, document CRUD, sharing)
  - `collab/`: Hocuspocus WebSocket server (live editing)
  - They share one PostgreSQL database and one `JWT_SECRET`. Locally: two ports.
- **Database:** PostgreSQL via `pg` (parameterized queries only, no ORM).
- **Auth:** `bcryptjs` for password hashing, `jsonwebtoken` for JWT.
- **Tests:** Vitest (unit), Playwright (multi-browser real-time tests).
- **Deployment:** Render (or similar); Hocuspocus must run over WSS.
- **Dependencies:** keep to the minimum. Ask before adding anything not listed here.
- **Docs to follow:** use the current Tiptap and Hocuspocus documentation (tiptap.dev/docs/hocuspocus and tiptap.dev/docs/editor/api/extensions/collaboration). Package and extension names change between versions, so check the docs instead of relying on memory.

## Architecture

```
Browser (React + Tiptap + Y.Doc)
   |  HTTP (JWT in Authorization header)        |  WebSocket (JWT as provider token)
   v                                            v
Express REST API  ----------------------  Hocuspocus collab server
   |                                            |
   +------------------ PostgreSQL --------------+
        users, documents (metadata + ydoc_state bytea), permissions
```

**Auth flow**

1. User logs in via Express and receives a JWT.
2. REST calls: `Authorization: Bearer <jwt>`. Express middleware verifies the JWT, then checks the `permissions` table.
3. Live editing: the client passes the same JWT as the Hocuspocus provider `token`.
4. Hocuspocus `onAuthenticate` verifies the JWT, looks up the user's role for that document in Postgres, rejects if none, and sets `connection.readOnly = true` for viewers.
5. Each server enforces permissions independently. Neither trusts the client.

**Persistence flow**

- While a document is open, its `Y.Doc` lives in Hocuspocus memory.
- The store hook writes `Y.encodeStateAsUpdate(ydoc)` to `documents.ydoc_state` (debounced, and when the last user leaves).
- On first open, the load hook reads `ydoc_state` into a new `Y.Doc`.
- If loading fails, **reject the connection**. Never open an empty doc, or a later store could overwrite real data.

## Data model

```sql
users(id uuid pk, email text unique, password_hash text, name text, created_at timestamptz)
documents(id uuid pk, title text, owner_id uuid fk users, ydoc_state bytea, updated_at timestamptz)
permissions(doc_id uuid fk documents, user_id uuid fk users, role text check in ('owner','editor','viewer'), primary key (doc_id, user_id))
```

## Repo layout

```
/client   React + Vite app
/server   Express REST API
/collab   Hocuspocus server
/README.md
```

## Milestones

Work one milestone at a time. Stop at the end of each and wait for review.

### M1: Setup and Authentication
- Repo with `/client`, `/server`, `/collab`; `.env.example` files; `.gitignore` (never commit `.env`)
- `schema.sql` plus a `db:init` script for the three tables
- `POST /register`, `POST /login` (bcrypt + JWT), `GET /me`, `requireAuth` middleware
- Validation: email format, password >= 8 chars, unique email returns 409
- Same error message for unknown email and wrong password
- Client: login/register page, token stored, logout, basic Tiptap editor (bold, italic, headings, lists, undo/redo)
- **Done when:** register, log in, refresh (still logged in via `/me`), and type in the editor.

### M2: Documents (REST)
- Create, list, rename, delete documents. Creator becomes `owner` in `permissions`.
- Every endpoint checks the user's role for that document, not just login.
- Client: document list page, "New document" button, `/doc/:id` route
- Temporary save of editor content to the DB (removed in M3)
- **Done when:** create a document, type, refresh, and the text is still there. Another user gets 403/404 on it.

### M3: Real-Time Sync
- `collab/`: Hocuspocus server with `onAuthenticate` (verify JWT, check role for `documentName`)
- Client: `HocuspocusProvider` per document, Tiptap Collaboration extension bound to its `Y.Doc`; remove the temporary M2 save
- **Done when:** two browsers, two different users, same document, always identical, including when both type at the same position.

### M4: Persistence
- Load and store hooks against `documents.ydoc_state`
- **Done when:** restart the collab server and content is intact; open a document with no active session and it loads correctly.

### M5: Permissions and Sharing
- API: share by email with a role, list and remove collaborators (owner only)
- Viewers connect read-only on the server (`connection.readOnly = true`)
- When a role is removed or a document is deleted, close that user's live connections
- Client: read-only editor and "View only" badge; share dialog for owners
- **Done when:** a viewer cannot change the document even by sending raw Yjs updates from a custom client.

### M6: Hardening and Tests
Verify each scenario on purpose and add tests:

| Scenario | Expected behavior |
|---|---|
| WebSocket disconnect/reconnect | Client shows "Offline", keeps editing locally, auto-reconnects, both sides' edits merge |
| Simultaneous edits | Both preserved; identical final text everywhere |
| Duplicate/reordered updates | Handled by Yjs; write a test proving it |
| Expired JWT | Connect rejected, client redirects to login; REST returns 401 |
| Revoked permission | Live connection closed; reconnect rejected; UI shows "Access removed" |
| Deleted document | Connections closed; clients see "Document no longer exists" |
| Server restart | Clients reconnect and re-sync; state restored from Postgres |
| Database unavailable | Load fails: reject connection. Store fails: keep in memory, log, retry, do not crash. REST returns 503 |

- Also test: large paste, rapid typing, 3+ users in one paragraph
- Playwright: two browser contexts sync; viewer cannot edit; content persists after reload
- Vitest: auth and permission logic
- **Done when:** every row above has been triggered and behaves as described, and tests pass.

### M7: Deployment and README
- Deploy Postgres, Express, Hocuspocus (WSS), and the client; env vars and CORS configured
- Seed a demo account and demo document
- README: live link, architecture diagram, setup steps, demo GIF, decisions and tradeoffs (why Yjs, why Postgres, why two servers, how it would scale)
- **Done when:** a stranger can open the live link and try two tabs.

### M8: Optional (only if M1-M7 are solid)
Cursor names and colors, online-user avatars, version history, comments, PDF export, Yjs update compaction.

## Security requirements

- Passwords hashed with bcrypt; never stored or logged in plain text
- JWT verified (signature and expiry) on every REST request and every WebSocket connect; secret only in env vars
- Authorization checked server-side against `permissions` on every document operation
- Hiding UI controls is never treated as security
- Viewers blocked from editing on the server, not just in the UI
- Parameterized SQL only; CORS restricted to the client origin
- Generic 500 errors to the client; real errors logged server-side

## Out of scope

Custom CRDT/OT, Redis, Kubernetes, message queues, Next.js, ORMs, real-time features beyond editing and presence. Scaling is understood conceptually only (sticky routing by document ID, or Redis pub/sub across multiple Hocuspocus instances) and is documented in the README, not built.

## Working rules for Claude Code

1. **One milestone at a time.** Stop at the end and summarize what was built.
2. **Explain as you go.** After each milestone give a plain-language explanation of the key files and data flow, then ask me 3 questions to check my understanding before continuing.
3. **Small commits** with clear messages, one logical change each.
4. **Keep code simple and readable.** Comment only non-obvious decisions (especially auth, permission checks, and Yjs hooks).
5. **Verify before claiming done.** Run the server, run the tests, and check the "Done when" line for the milestone.
6. **Ask before** adding dependencies, changing the architecture, or skipping a requirement.
7. **Flag uncertainty.** If a library API may have changed, check the current docs instead of guessing.
