import { Router } from 'express';
import { pool } from '../db.js';
import { optionalAuth, requireAuth } from '../auth/requireAuth.js';
import { NOT_FOUND, requireDocumentRole } from '../auth/documentAccess.js';
import { notifyAccessChanged, notifyLinkAccessChanged } from '../accessEvents.js';
import { validateLinkAccess, validateTitle } from '../validation.js';
import { sharingRouter } from './sharing.js';

const DEFAULT_TITLE = 'Untitled document';

export const documentsRouter = Router();

// The ONE route open to visitors who aren't logged in: reading a document's details.
// requireDocumentRole still decides: an anonymous visitor only gets in when the owner
// switched link sharing on, and then only as a viewer. It sits above requireAuth on
// purpose: everything below it, and any route added later, requires a login by default.
// Metadata only: the content itself arrives over the collab WebSocket.
documentsRouter.get('/:id', optionalAuth, requireDocumentRole('viewer'), (req, res) => {
  res.json({ document: req.document });
});

documentsRouter.use(requireAuth);
documentsRouter.use('/:id/permissions', sharingRouter);

// Only documents the caller has a role on. The JOIN is the permission check.
documentsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.updated_at, p.role
       FROM permissions p
       JOIN documents d ON d.id = p.doc_id
      WHERE p.user_id = $1
      ORDER BY d.updated_at DESC`,
    [req.userId],
  );
  res.json({ documents: rows });
});

documentsRouter.post('/', async (req, res) => {
  const title = req.body?.title ?? DEFAULT_TITLE;
  const error = validateTitle(title);
  if (error) return res.status(400).json({ error });

  // The document and its owner permission are written in one transaction. Without it,
  // a crash between the two inserts would leave a document that nobody can open.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING id, title, updated_at',
      [title.trim(), req.userId],
    );
    await client.query("INSERT INTO permissions (doc_id, user_id, role) VALUES ($1, $2, 'owner')", [
      rows[0].id,
      req.userId,
    ]);
    await client.query('COMMIT');
    res.status(201).json({ document: { ...rows[0], role: 'owner' } });
  } catch (err) {
    await client.query('ROLLBACK');
    // Foreign key violation: the token is valid but its user has been deleted.
    if (err.code === '23503') return res.status(401).json({ error: 'Invalid or expired token' });
    throw err;
  } finally {
    client.release();
  }
});

// Owner only: choose what anyone with the link may do: nothing, view, or edit.
documentsRouter.put('/:id/link-access', requireDocumentRole('owner'), async (req, res) => {
  const access = req.body?.access;
  const error = validateLinkAccess(access);
  if (error) return res.status(400).json({ error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE locks the row while we read the old value, so two quick toggles queue up
    // instead of both seeing the same old value and both sending (or skipping) the notice.
    const { rows } = await client.query('SELECT link_access FROM documents WHERE id = $1 FOR UPDATE', [req.document.id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: NOT_FOUND });
    }
    await client.query('UPDATE documents SET link_access = $1 WHERE id = $2', [access, req.document.id]);
    // Any change cuts the connections that came in through the link, so they reconnect at
    // the new level (or are refused). Otherwise a visitor could keep editing after the
    // owner lowered the link to view only. Nothing is sent if the value did not change.
    if (rows[0].link_access !== access) await notifyLinkAccessChanged(client, req.document.id);
    await client.query('COMMIT');
    res.json({ link_access: access });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

documentsRouter.patch('/:id', requireDocumentRole('editor'), async (req, res) => {
  // Someone who is editing through the link may change the content, not the document's name.
  if (req.document.via_link) return res.status(403).json({ error: 'You do not have permission to do that' });
  const title = req.body?.title;
  const error = validateTitle(title);
  if (error) return res.status(400).json({ error });

  const { rows } = await pool.query(
    'UPDATE documents SET title = $1, updated_at = now() WHERE id = $2 RETURNING id, title, updated_at',
    [title.trim(), req.document.id],
  );
  // The document may have been deleted after the permission check ran.
  if (!rows[0]) return res.status(404).json({ error: NOT_FOUND });
  res.json({ document: { ...rows[0], role: req.document.role } });
});

documentsRouter.delete('/:id', requireDocumentRole('owner'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Permissions rows go with it (ON DELETE CASCADE).
    await client.query('DELETE FROM documents WHERE id = $1', [req.document.id]);
    // Close everyone's live connection; sent only if the delete commits.
    await notifyAccessChanged(client, req.document.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(204).end();
});
