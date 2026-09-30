import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function TopBar() {
  const { user, logout } = useAuth();

  return (
    <header className="topbar">
      <Link to="/" className="brand">Collab Docs</Link>
      <span>
        {user.name} ({user.email})
        <button type="button" onClick={logout}>Log out</button>
      </span>
    </header>
  );
}
