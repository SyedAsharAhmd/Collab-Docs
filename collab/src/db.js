import pg from 'pg';

// One shared pool per process. All queries must use $1-style parameters.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
