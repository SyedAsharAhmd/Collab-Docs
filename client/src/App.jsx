import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import EditorPage from './pages/EditorPage.jsx';

// Hiding pages is a UX convenience, not security: the server checks every request.
function RequireUser({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="centered">Loading…</p>;
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={!loading && user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <RequireUser>
            <EditorPage />
          </RequireUser>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
