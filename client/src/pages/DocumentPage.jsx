import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import TopBar from '../components/TopBar.jsx';
import Editor from '../editor/Editor.jsx';
import { useCollaboration } from '../editor/useCollaboration.js';

export default function DocumentPage() {
  const { id } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);

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
  }, [id]);

  let body;
  if (error) {
    // The server answers 404 for both "doesn't exist" and "no access", so the UI can't
    // (and shouldn't) tell them apart either.
    body = (
      <>
        <p className="error">{error.status === 404 ? 'Document not found.' : error.message}</p>
        <Link to="/">Back to documents</Link>
      </>
    );
  } else if (!doc) {
    body = <p>Loading…</p>;
  } else {
    body = <DocumentEditor key={doc.id} doc={doc} />;
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

function DocumentEditor({ doc }) {
  // Viewers get a read-only editor. This is only UX: the collab server marks their
  // connection read-only and drops any update they send.
  const canEdit = doc.role !== 'viewer';
  const { ydoc, status, deniedReason } = useCollaboration(doc.id);

  if (deniedReason) {
    return (
      <>
        <p className="error">
          {deniedReason === 'permission-denied'
            ? 'Document not found, or you no longer have access.'
            : 'Could not open the document. Please try again later.'}
        </p>
        <Link to="/">Back to documents</Link>
      </>
    );
  }

  return (
    <>
      <div className="doc-header">
        <Link to="/">← Documents</Link>
        <TitleInput doc={doc} disabled={!canEdit} />
        <span className="muted">
          {STATUS_TEXT[status]}
          {!canEdit && ' · View only'}
        </span>
      </div>
      {ydoc && <Editor key={ydoc.guid} ydoc={ydoc} editable={canEdit} />}
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
