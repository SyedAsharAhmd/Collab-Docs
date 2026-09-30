import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../auth/requireAuth.js';
import { NOT_FOUND, requireDocumentRole } from '../auth/documentAccess.js';
import { validateContent, validateTitle } from '../validation.js';

const DEFAULT_TITLE = 'Untitled document';

export const documentsRouter = Router();

documentsRouter.use(requireAuth);

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

documentsRouter.get('/:id', requireDocumentRole('viewer'), async (req, res) => {
  const { rows } = await pool.query('SELECT content FROM documents WHERE id = $1', [req.document.id]);
  if (!rows[0]) return res.status(404).json({ error: NOT_FOUND });
  res.json({ document: { ...req.document, content: rows[0].content } });
});

documentsRouter.patch('/:id', requireDocumentRole('editor'), async (req, res) => {
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

// M2 ONLY: temporary save of the editor's JSON. M3 replaces this with Yjs sync.
documentsRouter.put('/:id/content', requireDocumentRole('editor'), async (req, res) => {
  const content = req.body?.content;
  const error = validateContent(content);
  if (error) return res.status(400).json({ error });

  const { rowCount } = await pool.query(
    'UPDATE documents SET content = $1, updated_at = now() WHERE id = $2',
    [JSON.stringify(content), req.document.id],
  );
  if (!rowCount) return res.status(404).json({ error: NOT_FOUND });
  res.status(204).end();
});

documentsRouter.delete('/:id', requireDocumentRole('owner'), async (req, res) => {
  // Permissions rows go with it (ON DELETE CASCADE).
  await pool.query('DELETE FROM documents WHERE id = $1', [req.document.id]);
  res.status(204).end();
});
