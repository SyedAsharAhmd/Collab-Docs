import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';

// Shown over whatever page the user is on when their login expires. Logging in here
// (as the same account) resumes work without leaving the page; an open document then
// reconnects and syncs anything typed in the meantime.
export default function SessionExpiredDialog() {
  const { user, login, logout } = useAuth();
  const dialogRef = useRef(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      // The email is fixed: switching accounts here would attach this page's unsaved
      // work to someone else.
      await login(user.email, password);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="share-dialog session-dialog"
      aria-labelledby="session-expired-title"
      onCancel={(e) => e.preventDefault()} // Escape must not dismiss it
    >
      <h2 id="session-expired-title">Session expired</h2>
      <p>Log in again to keep working. Changes on this page are kept and sync once you're back.</p>
      <form onSubmit={handleSubmit}>
        <label>
          Email
          <input type="email" value={user.email} readOnly />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <button type="button" className="link" onClick={logout}>
        Log out instead
      </button>
    </dialog>
  );
}
