// Creates the tables. Usage: npm run db:init
// Pass a different database with DATABASE_URL, e.g. for the test database.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query(schema);
  console.log('Schema applied.');
} catch (err) {
  console.error('db:init failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
