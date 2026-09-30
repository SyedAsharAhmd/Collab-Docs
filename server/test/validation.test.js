import { describe, expect, it } from 'vitest';
import { normalizeEmail, validateRegistration } from '../src/validation.js';

const valid = { email: 'ada@example.com', password: 'correct horse', name: 'Ada' };

describe('validateRegistration', () => {
  it('accepts valid input', () => {
    expect(validateRegistration(valid)).toBeNull();
  });

  it.each(['', 'ada', 'ada@', '@example.com', 'ada@example', 'a da@example.com'])(
    'rejects email %j',
    (email) => {
      expect(validateRegistration({ ...valid, email })).toMatch(/email/i);
    },
  );

  it('rejects passwords shorter than 8 characters', () => {
    expect(validateRegistration({ ...valid, password: '1234567' })).toMatch(/at least 8/);
    expect(validateRegistration({ ...valid, password: '12345678' })).toBeNull();
  });

  it('rejects passwords over 72 bytes, counting multi-byte characters', () => {
    expect(validateRegistration({ ...valid, password: 'a'.repeat(72) })).toBeNull();
    // 25 three-byte characters = 75 bytes but only 25 characters.
    expect(validateRegistration({ ...valid, password: '€'.repeat(25) })).toMatch(/72 bytes/);
  });

  it('rejects a non-string password', () => {
    expect(validateRegistration({ ...valid, password: 12345678 })).toMatch(/password/i);
  });

  it('requires a name', () => {
    expect(validateRegistration({ ...valid, name: '   ' })).toMatch(/name/i);
    expect(validateRegistration({ ...valid, name: undefined })).toMatch(/name/i);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('returns an empty string for non-strings', () => {
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail({ $ne: '' })).toBe('');
  });
});
