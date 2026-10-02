import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import TopBar from '../components/TopBar.jsx';
import ShareDialog from '../components/ShareDialog.jsx';
import Editor from '../editor/Editor.jsx';
import { useCollaboration } from '../editor/useCollaboration.js';

export default function DocumentPage() {
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  // Bumped when the owner changes our access, to reload the document with our new role.
  const [reloads, setReloads] = useState(0);
  const [accessChangedId, setAccessChangedId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    api(`/documents/${id}`)
      .then(({ document }) => !cancelled && setDoc(document))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id, reloads]);

  const reload = useCallback(() => {
    setAccessChangedId(id);
    setReloads((n) => n + 1);
  }, [id]);

  let body;
  if (error) {
    // The server answers 404 for both "doesn't exist" and "no access". After an access
    // change we know which one it is, so we can say it plainly.
    let message = error.message;
    if (error.status === 404) message = accessChangedId === id ? 'Access removed. The owner no longer shares this document with you.' : 'Document not found.';
    body = (
      <>
        <p className="error">{message}</p>
        <Link to="/">Back to documents</Link>
      </>
    );
  } else if (!doc) {
    body = <p>Loading…</p>;
  } else {
    // A new key after a reload remounts the editor, so it reconnects with the new role.
    body = <DocumentEditor key={`${doc.id}:${reloads}`} doc={doc} onAccessChanged={reload} />;
  }

  return (
    <>
      <TopBar />
      <main className="page">{body}</main>
    </>
  );
}

const STATUS_TEXT = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Offline. Reconnecting…',
};

const DENIED_TEXT = {
  'permission-denied': 'Document not found, or you no longer have access.',
  'document-deleted': 'Document no longer exists. The owner deleted it.',
};

function DocumentEditor({ doc, onAccessChanged }) {
  // Viewers get a read-only editor. This is only UX: the collab server marks their
  // connection read-only and drops any update they send.
  const canEdit = doc.role !== 'viewer';
  const isOwner = doc.role === 'owner';
  const { ydoc, status, deniedReason } = useCollaboration(doc.id, onAccessChanged);
  const [sharing, setSharing] = useState(false);

  if (deniedReason) {
    return (
      <>
        <p className="error">{DENIED_TEXT[deniedReason] ?? 'Could not open the document. Please try again later.'}</p>
        <Link to="/">Back to documents</Link>
      </>
    );
  }

  return (
    <>
      <div className="doc-header">
        <Link to="/">← Documents</Link>
        <TitleInput doc={doc} disabled={!canEdit} />
        {!canEdit && <span className="badge">View only</span>}
        <span className="muted">{STATUS_TEXT[status]}</span>
        {isOwner && (
          <button type="button" className="primary" onClick={() => setSharing(true)}>
            Share
          </button>
        )}
      </div>
      {ydoc && <Editor key={ydoc.guid} ydoc={ydoc} editable={canEdit} />}
      {sharing && <ShareDialog docId={doc.id} onClose={() => setSharing(false)} />}
    </>
  );
}

function TitleInput({ doc, disabled }) {
  const [title, setTitle] = useState(doc.title);
  const [saved, setSaved] = useState(doc.title);
  const [error, setError] = useState('');

  async function commit() {
    const next = title.trim();
    if (next === saved) return setTitle(saved);
    try {
      const { document } = await api(`/documents/${doc.id}`, { method: 'PATCH', body: { title: next } });
      setTitle(document.title);
      setSaved(document.title);
      setError('');
    } catch (err) {
      setTitle(saved);
      setError(err.message);
    }
  }

  return (
    <>
      <input
        className="title-input"
        aria-label="Document title"
        value={title}
        maxLength={200}
        disabled={disabled}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {error && <span className="error" role="alert">{error}</span>}
    </>
  );
}
