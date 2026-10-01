import * as Y from 'yjs';
import { pool } from './db.js';

// Runs when a document is first opened and isn't already in memory. onAuthenticate
// has already run, so documentName is a valid id the caller has a role on.
//
// If this throws (e.g. the database is down), Hocuspocus closes the connections and
// never stores the document. That matters: opening an empty Y.Doc instead would let
// the next store overwrite the real content with nothing.
export async function onLoadDocument({ documentName }) {
  const { rows } = await pool.query('SELECT ydoc_state FROM documents WHERE id = $1', [documentName]);

  // Deleted between onAuthenticate and now: refuse rather than edit a ghost.
  if (!rows[0]) throw new Error('Document not found');

  // NULL means it has never been stored (a new document), so it starts empty.
  // Otherwise pg returns the bytea as a Buffer, which Hocuspocus applies to the Y.Doc.
  return rows[0].ydoc_state ?? undefined;
}

// Runs 2 s after the last change (at most every 10 s during constant typing), when the
// last user leaves, and on shutdown. If it throws, Hocuspocus logs the error and keeps
// the document in memory so nothing is lost.
export async function onStoreDocument({ documentName, document }) {
  // The full state as one update: loading it into an empty Y.Doc recreates the document.
  const state = Y.encodeStateAsUpdate(document);
  await pool.query('UPDATE documents SET ydoc_state = $1, updated_at = now() WHERE id = $2', [
    Buffer.from(state),
    documentName,
  ]);
}
