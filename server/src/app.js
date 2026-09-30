import express from 'express';
import { authRouter } from './routes/auth.js';

// Builds the app without listening, so tests can start it on a random port.
export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', authRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Express 5 forwards rejected promises from async handlers to here.
  // Express recognizes an error handler by its four parameters, so `next` must stay.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    // Log the real error on the server; the client only gets a generic message.
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
