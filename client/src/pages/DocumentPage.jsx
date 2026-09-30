import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import TopBar from '../components/TopBar.jsx';
import Editor from '../editor/Editor.jsx';
import { useAutosave } from '../editor/useAutosave.js';

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
  saved: 'All changes saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Save failed. Will retry on your next edit.',
};

function DocumentEditor({ doc }) {
  // Viewers get a read-only editor. This is only UX: the server rejects their saves.
  const canEdit = doc.role !== 'viewer';

  const saveContent = useCallback(
    (content, options) => api(`/documents/${doc.id}/content`, { method: 'PUT', body: { content }, ...options }),
    [doc.id],
  );
  const { status, schedule } = useAutosave(saveContent);

  return (
    <>
      <div className="doc-header">
        <Link to="/">← Documents</Link>
        <TitleInput doc={doc} disabled={!canEdit} />
        <span className="muted">{canEdit ? STATUS_TEXT[status] : 'View only'}</span>
      </div>
      <Editor content={doc.content} editable={canEdit} onChange={schedule} />
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
