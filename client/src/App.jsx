import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DocumentListPage from './pages/DocumentListPage.jsx';
import DocumentPage from './pages/DocumentPage.jsx';
import SessionExpiredDialog from './components/SessionExpiredDialog.jsx';

// Hiding pages is a UX convenience, not security: the server checks every request.
function RequireUser({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="centered">Loading…</p>;
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { user, loading, sessionExpired } = useAuth();

  return (
    <>
      <Routes>
        <Route
          path="/login"
          element={!loading && user ? <Navigate to="/" replace /> : <LoginPage />}
        />
        <Route
          path="/"
          element={
            <RequireUser>
              <DocumentListPage />
            </RequireUser>
          }
        />
        {/* Not behind RequireUser: a document with link sharing on is open to visitors who
            aren't logged in. The servers decide who gets in; anyone else sees "not found". */}
        <Route path="/doc/:id" element={<DocumentPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Over the current page, so nothing on it is lost while the user logs back in. */}
      {user && sessionExpired && <SessionExpiredDialog />}
    </>
  );
}
