import { pool } from './db.js';
import { verifyToken } from './jwt.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How many people may watch one document through its link at the same time. They have
// no account to limit, so this caps the memory and CPU they can use. Read at call time
// so tests can lower it.
const maxLinkViewers = () => Number(process.env.MAX_LINK_VIEWERS) || 100;

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

// The higher of two roles (either may be null). On a tie the first one is returned, so a
// role someone really has is never reported as coming from the link.
function betterRole(a, b) {
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}

// Throwing from onAuthenticate rejects the connection. Hocuspocus sends `reason`
// to the client, so it must never contain internal details.
function denied(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

// Runs once per document connection, before the client receives any document data.
// This server does not trust the REST API or the client: it checks the token and
// the permissions table itself.
export async function onAuthenticate({ token, documentName, connectionConfig, instance }) {
  // No token at all means an anonymous visitor. They get in only if the owner switched
  // link sharing on, and then only at the level the link allows (view or edit). A token
  // that IS sent must be valid:
  // otherwise a logged-in user whose session expired would quietly become anonymous.
  let userId = null;
  if (token) {
    try {
      userId = verifyToken(token);
    } catch {
      // A distinct reason, so the client knows to send the user back to login.
      throw denied('invalid-token');
    }
  }

  // Anyone refused gets one of two answers, never a hint about whether the document exists:
  // a visitor with no token is told to log in (which is also what an expired session
  // looks like to the client), and a logged-in user is told they have no access.
  const refusal = userId ? 'permission-denied' : 'invalid-token';

  // The document name is the document's id. Same rule as the REST API: a malformed
  // id, a missing document, and "no role" all get the same answer.
  if (!UUID_RE.test(documentName)) throw denied(refusal);

  let found;
  try {
    // LEFT JOIN: a document the caller has no role on still comes back, so the link
    // setting can be checked. (userId null matches no permission row.)
    const { rows } = await pool.query(
      `SELECT d.link_access, p.role
         FROM documents d
         LEFT JOIN permissions p ON p.doc_id = d.id AND p.user_id = $2
        WHERE d.id = $1`,
      [documentName, userId],
    );
    found = rows[0];
  } catch (err) {
    console.error('Permission lookup failed:', err);
    throw denied('server-error');
  }

  // The caller gets the better of the role they really have and what the link gives
  // ("viewer" or "editor", never "owner"): same rule as the REST API, so the two servers
  // always agree. `viaLink` marks a role that comes from the link.
  const linkRole = !found || found.link_access === 'none' ? null : found.link_access;
  const role = betterRole(found?.role, linkRole);
  if (!role) throw denied(refusal);
  const viaLink = role !== found.role;

  if (viaLink) {
    const open = instance.documents.get(documentName)?.getConnections().filter((c) => c.context?.viaLink).length ?? 0;
    if (open >= maxLinkViewers()) throw denied('too-many-viewers');
  }

  // Enforced here on the server, not in the UI: Hocuspocus drops every update that
  // arrives on a read-only connection, even from a hand-written client.
  connectionConfig.readOnly = role === 'viewer';

  // Becomes `context` in later hooks. `viaLink` marks connections that can be closed
  // when the owner switches link sharing off.
  return { userId, role, viaLink };
}
