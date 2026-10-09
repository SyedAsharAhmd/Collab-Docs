import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Owner-only. Hiding it from others is just UX: every sharing endpoint checks for the
// owner role on the server.
export default function ShareDialog({ docId, linkAccess, onLinkAccessChange, onClose }) {
  const dialogRef = useRef(null);
  const [collaborators, setCollaborators] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const path = `/documents/${docId}/permissions`;
  // The address of this document's page. It is the document's random id, so it can't be
  // guessed: it works like a password for whoever has it.
  const link = `${window.location.origin}/doc/${docId}`;

  const load = useCallback(
    () =>
      api(path)
        .then(({ collaborators }) => setCollaborators(collaborators))
        .catch((err) => setError(err.message)),
    [path],
  );

  useEffect(() => {
    dialogRef.current?.showModal();
    load();
  }, [load]);

  // Runs one change, then reloads the list so it shows what the server stored.
  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function share(e) {
    e.preventDefault();
    run(async () => {
      await api(path, { method: 'POST', body: { email, role } });
      setEmail('');
    });
  }

  const changeRole = (person, newRole) =>
    run(() => api(path, { method: 'POST', body: { email: person.email, role: newRole } }));
  const remove = (person) => run(() => api(`${path}/${person.user_id}`, { method: 'DELETE' }));

  // The select only changes once the server has confirmed, so it always shows what is stored.
  const changeLinkAccess = (access) =>
    run(async () => {
      const result = await api(`/documents/${docId}/link-access`, { method: 'PUT', body: { access } });
      onLinkAccessChange(result.link_access);
    });

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy automatically. Select the link and copy it.');
    }
  }

  return (
    <dialog ref={dialogRef} className="share-dialog" onClose={onClose}>
      <h2>Share</h2>
      <form className="share-form" onSubmit={share}>
        <input
          type="email"
          placeholder="Email address"
          aria-label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button type="submit" className="primary" disabled={busy}>Share</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}

      {collaborators === null ? (
        <p>Loading…</p>
      ) : (
        <ul className="collaborators">
          {collaborators.map((person) => (
            <li key={person.user_id}>
              <span>
                {person.name} <span className="muted">{person.email}</span>
              </span>
              {person.role === 'owner' ? (
                <span className="muted">Owner</span>
              ) : (
                <span>
                  <select
                    aria-label={`Role for ${person.email}`}
                    value={person.role}
                    disabled={busy}
                    onChange={(e) => changeRole(person, e.target.value)}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button type="button" className="danger" disabled={busy} onClick={() => remove(person)}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <section className="link-access">
        <div className="link-toggle">
          <label htmlFor="link-access">Anyone with the link</label>
          <select
            id="link-access"
            value={linkAccess}
            disabled={busy}
            onChange={(e) => changeLinkAccess(e.target.value)}
          >
            <option value="none">Cannot open it</option>
            <option value="viewer">Can view</option>
            <option value="editor">Can edit</option>
          </select>
        </div>
        {linkAccess !== 'none' && (
          <>
            <div className="link-row">
              <input readOnly aria-label="Link to this document" value={link} onFocus={(e) => e.target.select()} />
              <button type="button" className="secondary" onClick={copyLink}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <p className="muted">
              {linkAccess === 'viewer'
                ? "They can read it live but not edit it, and they don't need an account. "
                : "They can edit it live without an account, and anything they type or delete is saved. There is no version history to undo changes. "}
              Anyone who has the link can pass it on.
            </p>
          </>
        )}
      </section>

      <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>Done</button>
    </dialog>
  );
}
