import { pool } from './db.js';
import { verifyToken } from './jwt.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export async function onAuthenticate({ token, documentName, connectionConfig }) {
  let userId;
  try {
    userId = verifyToken(token);
  } catch {
    // A distinct reason, so the client knows to send the user back to login.
    throw denied('invalid-token');
  }

  // The document name is the document's id. Same rule as the REST API: a malformed
  // id, a missing document, and "no role" all get the same answer.
  if (!UUID_RE.test(documentName)) throw denied('permission-denied');

  let role;
  try {
    const { rows } = await pool.query(
      'SELECT role FROM permissions WHERE doc_id = $1 AND user_id = $2',
      [documentName, userId],
    );
    role = rows[0]?.role;
  } catch (err) {
    console.error('Permission lookup failed:', err);
    throw denied('server-error');
  }
  if (!role) throw denied('permission-denied');

  // Enforced here on the server, not in the UI: Hocuspocus drops every update that
  // arrives on a read-only connection, even from a hand-written client.
  connectionConfig.readOnly = role === 'viewer';

  // Becomes `context` in later hooks (used by the persistence hooks in M4).
  return { userId, role };
}
