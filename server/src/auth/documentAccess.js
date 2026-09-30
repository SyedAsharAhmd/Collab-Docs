import { pool } from '../db.js';

// Higher rank = more rights. Each route names the lowest role it accepts.
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_FOUND = 'Document not found';

export function hasRole(role, minRole) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minRole];
}

// Loads the document named by :id together with the caller's role on it, and
// sets req.document. Must run after requireAuth.
//
// - No such document, or the caller has no role on it -> 404 in both cases.
//   Answering 403 would confirm to an outsider that the document exists.
// - Caller has a role, but it is too low for this action -> 403.
//   They can already see the document, so there is nothing left to hide.
export function requireDocumentRole(minRole) {
  return async (req, res, next) => {
    const { id } = req.params;
    // A malformed id can't match anything. Checking here also keeps Postgres from
    // throwing "invalid input syntax for type uuid", which would surface as a 500.
    if (!UUID_RE.test(id)) return res.status(404).json({ error: NOT_FOUND });

    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.updated_at, p.role
         FROM documents d
         JOIN permissions p ON p.doc_id = d.id AND p.user_id = $2
        WHERE d.id = $1`,
      [id, req.userId],
    );
    const document = rows[0];

    if (!document) return res.status(404).json({ error: NOT_FOUND });
    if (!hasRole(document.role, minRole)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }

    req.document = document;
    next();
  };
}
