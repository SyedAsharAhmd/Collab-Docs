import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function TopBar() {
  const { user, logout } = useAuth();

  return (
    <header className="topbar">
      <Link to="/" className="brand">Collab Docs</Link>
      {user ? (
        <span>
          {user.name} <span className="topbar-email">({user.email})</span>
          <button type="button" className="secondary" onClick={logout}>Log out</button>
        </span>
      ) : (
        // A visitor opening a shared link isn't logged in.
        <Link to="/login">Log in</Link>
      )}
    </header>
  );
}
