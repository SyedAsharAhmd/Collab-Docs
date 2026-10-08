import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import TopBar from '../components/TopBar.jsx';

export default function DocumentListPage() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api('/documents')
      .then(({ documents }) => !cancelled && setDocuments(documents))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function createDocument() {
    setCreating(true);
    setError('');
    try {
      const { document } = await api('/documents', { method: 'POST' });
      navigate(`/doc/${document.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  async function deleteDocument(doc) {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    setError('');
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE' });
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <TopBar />
      <main className="page">
        <div className="list-header">
          <h1>Documents</h1>
          <button type="button" className="primary" onClick={createDocument} disabled={creating}>
            {creating ? 'Creating…' : 'New document'}
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {documents === null && !error && <p className="muted">Loading…</p>}
        {documents?.length === 0 && (
          <div className="empty">
            <p><strong>No documents yet</strong></p>
            <p className="muted">Create one to get started.</p>
          </div>
        )}
        {documents?.length > 0 && (
          <ul className="doc-list">
            {documents.map((doc) => (
              <li key={doc.id}>
                <Link to={`/doc/${doc.id}`}>{doc.title}</Link>
                <span className="muted">
                  {doc.role} · edited {new Date(doc.updated_at).toLocaleString()}
                </span>
                {/* Shown to owners only for convenience; the server enforces it. */}
                {doc.role === 'owner' && (
                  <button type="button" className="danger" onClick={() => deleteDocument(doc)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
