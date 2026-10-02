import pg from 'pg';

// One shared pool per process. All queries must use $1-style parameters.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // pg's default is to wait forever for a connection; fail fast instead.
  connectionTimeoutMillis: 5000,
});

// An idle connection that dies (e.g. Postgres restarts) emits 'error' on the pool.
// Unhandled, that event would crash the server and drop every open document.
pool.on('error', (err) => console.error('Idle database connection lost:', err.message));
