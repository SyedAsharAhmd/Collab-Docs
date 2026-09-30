import { useAuth } from '../auth/AuthContext.jsx';
import Editor from '../editor/Editor.jsx';

// M1: one local editor, nothing saved. M2 replaces this with a document list and /doc/:id.
export default function EditorPage() {
  const { user, logout } = useAuth();

  return (
    <>
      <header className="topbar">
        <strong>Collab Docs</strong>
        <span>
          {user.name} ({user.email})
          <button type="button" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        <Editor />
      </main>
    </>
  );
}
