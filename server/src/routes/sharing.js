import { Router } from 'express';
import { pool } from '../db.js';
import { notifyAccessChanged } from '../accessEvents.js';
import { requireDocumentRole } from '../auth/documentAccess.js';
import { normalizeEmail, validateShareRole } from '../validation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mounted at /documents/:id/permissions. Every route is owner-only.
export const sharingRouter = Router({ mergeParams: true });

sharingRouter.use(requireDocumentRole('owner'));

sharingRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.email, u.name, p.role
       FROM permissions p
       JOIN users u ON u.id = p.user_id
      WHERE p.doc_id = $1
      ORDER BY (p.role = 'owner') DESC, u.email`,
    [req.document.id],
  );
  res.json({ collaborators: rows });
});

// Share with someone, or change their role.
sharingRouter.post('/', async (req, res) => {
  const role = req.body?.role;
  const roleError = validateShareRole(role);
  if (roleError) return res.status(400).json({ error: roleError });

  const email = normalizeEmail(req.body?.email);
  const { rows: users } = await pool.query('SELECT id, email, name FROM users WHERE email = $1', [email]);
  const target = users[0];
  // Tells the owner the email isn't registered. This reveals whether an account exists,
  // but only to logged-in users sharing their own document (a deliberate trade-off).
  if (!target) return res.status(404).json({ error: 'No account with that email' });
  if (target.id === req.userId) return res.status(400).json({ error: 'You already own this document' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock their current row (if any) so two simultaneous changes can't interleave.
    const { rows: current } = await client.query(
      'SELECT role FROM permissions WHERE doc_id = $1 AND user_id = $2 FOR UPDATE',
      [req.document.id, target.id],
    );
    const previousRole = current[0]?.role;
    if (previousRole === 'owner') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "The owner's role can't be changed" });
    }

    await client.query(
      `INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [req.document.id, target.id, role],
    );
    // A changed role means their open connection has the wrong rights (e.g. still
    // writable after a downgrade), so the collab server must close it.
    if (previousRole && previousRole !== role) await notifyAccessChanged(client, req.document.id, target.id);
    await client.query('COMMIT');

    res
      .status(previousRole ? 200 : 201)
      .json({ collaborator: { user_id: target.id, email: target.email, name: target.name, role } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

sharingRouter.delete('/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'Collaborator not found' });
  if (userId === req.userId) return res.status(400).json({ error: "The owner can't be removed" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      "DELETE FROM permissions WHERE doc_id = $1 AND user_id = $2 AND role <> 'owner'",
      [req.document.id, userId],
    );
    if (rowCount) await notifyAccessChanged(client, req.document.id, userId);
    await client.query('COMMIT');
    if (!rowCount) return res.status(404).json({ error: 'Collaborator not found' });
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
