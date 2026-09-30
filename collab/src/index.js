import { createServer } from './server.js';

for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing required env var ${name}. See collab/.env.example.`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT) || 1234;
createServer().listen(port);
