import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AUTH_EXPIRED_EVENT, api, tokenStore } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // True until we know whether the stored token is still valid.
  const [loading, setLoading] = useState(() => Boolean(tokenStore.get()));
  // True when a server rejected our token while the user was working. They stay on
  // their page, so an open document (and anything typed offline) isn't thrown away,
  // until they log in again or choose to log out.
  const [sessionExpired, setSessionExpired] = useState(false);

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

  // Any API call or live connection that gets its token rejected has already cleared
  // the token. On page load there's no user yet, so that just means the login page.
  useEffect(() => {
    const onExpired = () => setSessionExpired(true);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const authenticate = useCallback(async (path, body) => {
    const { token, user } = await api(path, { method: 'POST', body });
    tokenStore.set(token);
    setUser(user);
    setSessionExpired(false);
  }, []);

  const login = useCallback((email, password) => authenticate('/login', { email, password }), [authenticate]);
  const register = useCallback(
    (name, email, password) => authenticate('/register', { name, email, password }),
    [authenticate],
  );
  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setSessionExpired(false);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, sessionExpired, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
