import express from 'express';
import { cors } from './cors.js';
import { isDatabaseUnavailable } from './db.js';
import { createAuthRouter, DEFAULT_AUTH_LIMITS } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';

// Builds the app without listening, so tests can start it on a random port.
export function createApp({
  clientOrigin = process.env.CLIENT_ORIGIN,
  authLimits = DEFAULT_AUTH_LIMITS,
  trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 0,
} = {}) {
  const app = express();

  // Behind a hosting proxy, every request arrives from the proxy's address, and the
  // real client's IP is in X-Forwarded-For. Rate limiting needs the real one. Trust
  // exactly as many proxies as there really are: trusting more would let a client
  // put a fake IP in that header and dodge the per-IP limit.
  if (trustProxyHops) app.set('trust proxy', trustProxyHops);

  app.use(cors(clientOrigin));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', createAuthRouter(authLimits));
  app.use('/api/documents', documentsRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Express 5 forwards rejected promises from async handlers to here.
  // Express recognizes an error handler by its four parameters, so `next` must stay.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large' });
    }
    if (isDatabaseUnavailable(err)) {
      console.error('Database unavailable:', err.message);
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' });
    }
    // Log the real error on the server; the client only gets a generic message.
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
