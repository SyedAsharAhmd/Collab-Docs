import jwt from 'jsonwebtoken';

// Must match server/src/auth/jwt.js: same JWT_SECRET, same pinned algorithm.
// It's a copy rather than an import so each server can be installed and deployed
// on its own, without the other's node_modules.
const ALGORITHM = 'HS256';

// Returns the user id, or throws if the signature is invalid or the token has expired.
export function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  const payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
  if (typeof payload.sub !== 'string') throw new Error('Token has no subject');
  return payload.sub;
}
