import { createApp } from './app.js';

for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing required env var ${name}. See server/.env.example.`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT) || 3001;
createApp().listen(port, () => console.log(`API listening on http://localhost:${port}`));
