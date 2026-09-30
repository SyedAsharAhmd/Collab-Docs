// Token helpers with no Express dependency, so collab/ can use the same logic.
import jwt from 'jsonwebtoken';

const ALGORITHM = 'HS256';
const EXPIRES_IN = '1h';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set');
  return value;
}

export function signToken(userId) {
  return jwt.sign({ sub: userId }, secret(), { algorithm: ALGORITHM, expiresIn: EXPIRES_IN });
}

// Returns the user id, or throws if the signature is invalid or the token has expired.
// The algorithm is pinned so a token can't pick a different one (e.g. "none").
export function verifyToken(token) {
  const payload = jwt.verify(token, secret(), { algorithms: [ALGORITHM] });
  if (typeof payload.sub !== 'string') throw new Error('Token has no subject');
  return payload.sub;
}
