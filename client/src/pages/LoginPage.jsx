import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';
  const update = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (isRegister) await register(form.name, form.email, form.password);
      else await login(form.email, form.password);
      // Success updates the auth context, and App redirects to "/".
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  function switchMode() {
    setMode(isRegister ? 'login' : 'register');
    setError('');
  }

  return (
    <main className="auth-card">
      <h1>{isRegister ? 'Create an account' : 'Log in'}</h1>
      <form onSubmit={handleSubmit}>
        {isRegister && (
          <label>
            Name
            <input value={form.name} onChange={update('name')} required autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={form.email} onChange={update('email')} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={update('password')}
            required
            minLength={isRegister ? 8 : undefined}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
          />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>
      </form>
      <button type="button" className="link" onClick={switchMode}>
        {isRegister ? 'Already have an account? Log in' : 'No account? Create one'}
      </button>
    </main>
  );
}
