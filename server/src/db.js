import pg from 'pg';

// One shared pool per process. All queries must use $1-style parameters.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // pg's default is to wait forever for a connection, which would make every request
  // hang while the database is unreachable. Fail fast instead.
  connectionTimeoutMillis: 5000,
});

// An idle connection that dies (e.g. Postgres restarts) emits 'error' on the pool.
// Unhandled, that event would crash the whole process. The pool replaces the
// connection on its own, so logging is enough.
pool.on('error', (err) => console.error('Idle database connection lost:', err.message));

// Errors meaning "the database can't be reached right now", as opposed to a bug in a
// query. The API answers these with 503 so clients know to retry later.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', // Postgres shutting down, crashed, or not yet accepting connections
  '53300', // too many connections
]);

export function isDatabaseUnavailable(err) {
  if (UNAVAILABLE_CODES.has(err?.code) || /^08/.test(err?.code ?? '')) return true; // 08xxx = connection exceptions
  return /Connection terminated|timeout exceeded when trying to connect/i.test(err?.message ?? '');
}
