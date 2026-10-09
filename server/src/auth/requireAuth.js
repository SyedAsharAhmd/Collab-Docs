import { verifyToken } from './jwt.js';

// Proves who the caller is. It does NOT decide what they may access:
// document routes still check the permissions table themselves.
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.userId = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  next();
}

// Like requireAuth, but lets a request with no Authorization header through as an
// anonymous visitor (req.userId stays undefined). Only for routes where the data
// itself may be public.
//
// A token that IS sent but is invalid or expired is still a 401: otherwise a logged-in
// user whose session expired would silently become an anonymous visitor.
export function optionalAuth(req, res, next) {
  if (!req.get('Authorization')) return next();
  return requireAuth(req, res, next);
}
