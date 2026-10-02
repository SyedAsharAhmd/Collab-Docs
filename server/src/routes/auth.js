import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { signToken } from '../auth/jwt.js';
import { requireAuth } from '../auth/requireAuth.js';
import { RateLimiter } from '../rateLimit.js';
import { normalizeEmail, validateRegistration } from '../validation.js';

const BCRYPT_COST = 12;
const INVALID_LOGIN = 'Invalid email or password';

// Compared against when the email doesn't exist, so an unknown email takes as long
// as a wrong password. Otherwise response time would reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_COST);

// Never select password_hash into anything that gets sent to the client.
const toPublicUser = ({ id, email, name }) => ({ id, email, name });

export const DEFAULT_AUTH_LIMITS = {
  // Login + register attempts per IP. bcrypt takes ~300 ms of the API's only thread,
  // so this caps how much of the server one machine can tie up.
  perIp: { limit: Number(process.env.AUTH_RATE_LIMIT_PER_IP) || 20, windowMs: 60_000 },
  // Login attempts per email, cleared by a successful login. Stops password guessing
  // against one account, even when the attempts come from many IPs.
  perEmail: { limit: 5, windowMs: 15 * 60_000 },
};

export function createAuthRouter(limits = DEFAULT_AUTH_LIMITS) {
  const router = Router();
  const ipLimiter = new RateLimiter(limits.perIp);
  const emailLimiter = new RateLimiter(limits.perEmail);

  const tooManyAttempts = (res, seconds) =>
    res
      .set('Retry-After', String(seconds))
      .status(429)
      .json({ error: `Too many attempts. Try again in ${seconds} seconds.` });

  // Runs before any bcrypt work, so a flood of attempts is turned away cheaply.
  function limitByIp(req, res, next) {
    const wait = ipLimiter.retryAfter(req.ip);
    if (wait) return tooManyAttempts(res, wait);
    ipLimiter.hit(req.ip);
    next();
  }

  router.post('/register', limitByIp, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const { password, name } = req.body ?? {};

    const error = validateRegistration({ email, password, name });
    if (error) return res.status(400).json({ error });

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
        [email, passwordHash, name.trim()],
      );
      const user = toPublicUser(rows[0]);
      res.status(201).json({ token: signToken(user.id), user });
    } catch (err) {
      // Let the UNIQUE constraint detect duplicates. Checking first and then inserting
      // would race when two requests register the same email at the same moment.
      if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered' });
      throw err;
    }
  });

  router.post('/login', limitByIp, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    // Counted before checking the password, not after a failure: otherwise many
    // attempts sent at once would all pass this check while the first ones are still
    // being hashed. Unknown emails are counted too, so a 429 doesn't reveal which
    // emails are registered.
    const wait = emailLimiter.retryAfter(email);
    if (wait) return tooManyAttempts(res, wait);
    emailLimiter.hit(email);

    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

    // Same status and message for "no such user" and "wrong password".
    if (!user || !ok) return res.status(401).json({ error: INVALID_LOGIN });

    emailLimiter.reset(email); // the real owner shouldn't stay counted after logging in
    res.json({ token: signToken(user.id), user: toPublicUser(user) });
  });

  router.get('/me', requireAuth, async (req, res) => {
    // Reload from the DB rather than trusting the token: the account may have been deleted.
    const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired token' });
    res.json({ user: toPublicUser(rows[0]) });
  });

  return router;
}
