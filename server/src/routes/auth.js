import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { signToken } from '../auth/jwt.js';
import { requireAuth } from '../auth/requireAuth.js';
import { normalizeEmail, validateRegistration } from '../validation.js';

const BCRYPT_COST = 12;
const INVALID_LOGIN = 'Invalid email or password';

// Compared against when the email doesn't exist, so an unknown email takes as long
// as a wrong password. Otherwise response time would reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_COST);

// Never select password_hash into anything that gets sent to the client.
const toPublicUser = ({ id, email, name }) => ({ id, email, name });

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
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

authRouter.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const { rows } = await pool.query(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);

  // Same status and message for "no such user" and "wrong password".
  if (!user || !ok) return res.status(401).json({ error: INVALID_LOGIN });

  res.json({ token: signToken(user.id), user: toPublicUser(user) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  // Reload from the DB rather than trusting the token: the account may have been deleted.
  const { rows } = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
  if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired token' });
  res.json({ user: toPublicUser(rows[0]) });
});
