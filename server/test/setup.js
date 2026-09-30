// Runs before each test file, before the app (and its pg pool) is imported.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

// Point the app at the test database so tests never wipe real data.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
process.env.JWT_SECRET ||= 'test-secret-at-least-32-characters-long';
