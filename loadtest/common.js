import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Load tests use the TEST database (wiped freely) and their own ports and secret, so
// they never touch dev data or running dev servers.
if (existsSync('../server/.env')) process.loadEnvFile('../server/.env');
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set in server/.env');
export const JWT_SECRET = 'loadtest-secret-not-used-anywhere-else-0123456789';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

export async function resetDatabase() {
  await pool.query(await readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  await pool.query('TRUNCATE users CASCADE');
}

const SAMPLER = new URL('./sampler.js', import.meta.url).href;

// Starts server/ or collab/ as a separate process (so the server and the load
// generator don't share a CPU thread) and waits until it answers HTTP.
export async function startServer({ dir, env, readyUrl }) {
  const child = spawn(process.execPath, ['--import', SAMPLER, 'src/index.js'], {
    cwd: fileURLToPath(new URL(`../${dir}/`, import.meta.url)),
    env: { ...process.env, ...env, DATABASE_URL, JWT_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.samples = []; // { cpu, rssMb } once a second
  child.errorLines = [];
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('LOADTEST_STATS ')) child.samples.push(JSON.parse(line.slice(15)));
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => child.errorLines.push(...chunk.split('\n').filter(Boolean)));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${dir} exited:\n${child.errorLines.join('\n')}`);
    try {
      await fetch(readyUrl);
      return child;
    } catch {
      if (Date.now() > deadline) throw new Error(`${dir} did not start in 15 s`);
      await sleep(200);
    }
  }
}

// CPU and memory of a server while `run` executes.
export async function measureServer(server, run) {
  const from = server.samples.length;
  const result = await run();
  await sleep(1100); // include the last full second
  const window = server.samples.slice(from);
  return {
    ...result,
    'server CPU % avg': Math.round(average(window.map((s) => s.cpu))),
    'server CPU % max': Math.max(...window.map((s) => s.cpu)),
    'server MB max': Math.max(...window.map((s) => s.rssMb)),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const average = (values) => values.reduce((sum, v) => sum + v, 0) / (values.length || 1);

export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export const ms = (value) => Math.round(value * 10) / 10;
