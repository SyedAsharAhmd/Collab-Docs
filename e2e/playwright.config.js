import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// The e2e stack uses the TEST database (from server/.env) and its own ports, so it
// never touches dev data or clashes with running dev servers.
if (existsSync('../server/.env')) process.loadEnvFile('../server/.env');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set in server/.env');

const API_PORT = 3101;
const COLLAB_PORT = 1334;
const CLIENT_PORT = 4273;
const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;
// Shared by both servers; tests also sign tokens with it (see tests/helpers.js).
export const E2E_JWT_SECRET = 'e2e-secret-not-used-anywhere-else-0123456789';

const serverEnv = { DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: E2E_JWT_SECRET };

export default defineConfig({
  testDir: './tests',
  // Tests share one database and register unique users, but run one at a time to keep
  // multi-user timing predictable.
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: CLIENT_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Same start command as on Render: apply the schema, then start.
      command: 'node db/init.js && node src/index.js',
      cwd: '../server',
      env: { ...serverEnv, PORT: String(API_PORT), CLIENT_ORIGIN },
      url: `http://localhost:${API_PORT}/api/me`, // answers 401 once it's up
      reuseExistingServer: false,
    },
    {
      command: 'node src/index.js',
      cwd: '../collab',
      env: { ...serverEnv, PORT: String(COLLAB_PORT) },
      url: `http://localhost:${COLLAB_PORT}`,
      reuseExistingServer: false,
    },
    {
      // A production build, served the way a static host would, talking to the API
      // cross-origin (so CORS is exercised too).
      command: `npm run build -- --outDir ../e2e/.client-dist --emptyOutDir && npx vite preview --outDir ../e2e/.client-dist --port ${CLIENT_PORT} --strictPort`,
      cwd: '../client',
      env: {
        VITE_API_URL: `http://localhost:${API_PORT}`,
        VITE_COLLAB_URL: `ws://localhost:${COLLAB_PORT}`,
      },
      url: CLIENT_ORIGIN,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
