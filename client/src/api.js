const API_URL = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'token';

// The token lives in localStorage. Any script on the page can read it (an XSS risk),
// but the collaboration WebSocket (M3) must send it from JS anyway.
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

// Fired when the server rejects our token (expired, or the user was deleted).
// AuthContext listens and logs the user out.
export const AUTH_EXPIRED_EVENT = 'auth:expired';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// fetch wrapper: adds the Bearer token and turns non-2xx responses into ApiError.
// `keepalive` lets a request finish after the page is closed (used for a last save).
export async function api(path, { method = 'GET', body, keepalive = false } = {}) {
  const headers = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }

  // 401 on a request that carried a token means the token is no longer accepted.
  // (A 401 from a login attempt carries no token, so it doesn't log anyone out.)
  if (res.status === 401 && token) {
    tokenStore.clear();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Something went wrong');
  return data;
}
