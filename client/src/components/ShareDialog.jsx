import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Owner-only. Hiding it from others is just UX: every sharing endpoint checks for the
// owner role on the server.
export default function ShareDialog({ docId, onClose }) {
  const dialogRef = useRef(null);
  const [collaborators, setCollaborators] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const path = `/documents/${docId}/permissions`;

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

      <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>Done</button>
    </dialog>
  );
}
