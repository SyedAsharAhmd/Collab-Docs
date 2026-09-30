import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, tokenStore } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // True until we know whether the stored token is still valid.
  const [loading, setLoading] = useState(() => Boolean(tokenStore.get()));

  // On page load, ask the server who we are. Only the server can say if the token
  // is still valid (signature, expiry, user not deleted), so we don't decode it ourselves.
  useEffect(() => {
    if (!tokenStore.get()) return;
    let cancelled = false;
    api('/me')
      .then(({ user }) => !cancelled && setUser(user))
      .catch((err) => {
        if (err.status === 401) tokenStore.clear();
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const authenticate = useCallback(async (path, body) => {
    const { token, user } = await api(path, { method: 'POST', body });
    tokenStore.set(token);
    setUser(user);
  }, []);

  const login = useCallback((email, password) => authenticate('/login', { email, password }), [authenticate]);
  const register = useCallback(
    (name, email, password) => authenticate('/register', { name, email, password }),
    [authenticate],
  );
  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
