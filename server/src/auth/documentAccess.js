import { pool } from '../db.js';

// Higher rank = more rights. Each route names the lowest role it accepts.
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NOT_FOUND = 'Document not found';

export function hasRole(role, minRole) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[minRole];
}

// The higher of two roles (either may be null). On a tie the first one is returned, so a
// role someone really has is never reported as coming from the link.
function betterRole(a, b) {
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}

// Loads the document named by :id together with the caller's role on it, and
// sets req.document. Runs after requireAuth, or after optionalAuth on the one route
// anonymous visitors may use (req.userId is then undefined).
//
// - No such document, or the caller has no role on it -> 404 in both cases.
//   Answering 403 would confirm to an outsider that the document exists.
// - Caller has a role, but it is too low for this action -> 403.
//   They can already see the document, so there is nothing left to hide.
//
// Link sharing: if the owner switched it on, the link gives "viewer" or "editor", to
// anyone, logged in or not. The caller gets the better of that and any role they really
// have, so a link never takes rights away from someone. A link never gives "owner", so
// routes that need the owner (sharing, deleting, the link setting itself) still refuse
// it. `via_link` says the caller's role comes from the link rather than from a
// permission row.
export function requireDocumentRole(minRole) {
  return async (req, res, next) => {
    const { id } = req.params;
    // A malformed id can't match anything. Checking here also keeps Postgres from
    // throwing "invalid input syntax for type uuid", which would surface as a 500.
    if (!UUID_RE.test(id)) return res.status(404).json({ error: NOT_FOUND });

    // LEFT JOIN: a document with no permission row for this caller still comes back,
    // so the link setting can be checked.
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.updated_at, d.link_access, p.role
         FROM documents d
         LEFT JOIN permissions p ON p.doc_id = d.id AND p.user_id = $2
        WHERE d.id = $1`,
      [id, req.userId ?? null],
    );
    const found = rows[0];
    if (!found) return res.status(404).json({ error: NOT_FOUND });

    const linkRole = found.link_access === 'none' ? null : found.link_access;
    const role = betterRole(found.role, linkRole);
    if (!role) return res.status(404).json({ error: NOT_FOUND });
    const viaLink = role !== found.role;
    if (!hasRole(role, minRole)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }

    req.document = {
      id: found.id,
      title: found.title,
      updated_at: found.updated_at,
      link_access: found.link_access,
      role,
      via_link: viaLink,
    };
    next();
  };
}
