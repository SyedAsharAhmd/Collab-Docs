// Deliberately simple: one @, no spaces, a dot in the domain. Real proof of an
// email address would need a confirmation email, which is out of scope.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PASSWORD_MIN = 8;
// bcrypt silently ignores bytes after the 72nd, so longer passwords are rejected instead.
export const PASSWORD_MAX_BYTES = 72;

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Returns an error message, or null if the input is valid.
export function validateRegistration({ email, password, name }) {
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Please enter a valid email address';
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    return 'Name is required (max 100 characters)';
  }
  return null;
}

export const TITLE_MAX = 200;

export function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) {
    return `Title is required (max ${TITLE_MAX} characters)`;
  }
  return null;
}