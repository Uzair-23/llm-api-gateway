import express, { Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { connectMongo } from './config/mongo';
import { getRedis } from './config/redis';
import authRoutes from './routes/auth.routes';
import { errorHandler } from './middleware/errorHandler.middleware';
import { auth } from './middleware/auth.middleware';
// Side-effect import: augments Express Request with `req.tenant` for jwtAuth.
import './types/request.types';

const app: Express = express();

app.use(cors());
app.use(express.json());

// Health check (public) — useful for Nginx/LB and for tests.
app.get('/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Temporary API-key-protected route for testing the auth middleware in
// isolation before Phase 6 wires it onto /v1/chat/completions. Returns the
// authenticated tenant id so tests can assert the middleware attached it.
app.get('/v1/health/protected', auth, (req, res) => {
  res.json({ status: 'ok', tenantId: req.tenant?.tenantId });
});

// Auth routes mounted at /auth.
app.use('/auth', authRoutes);

// Centralized error handler — must be registered after all routes.
app.use(errorHandler);

if (env.NODE_ENV !== 'test') {
  const port = env.PORT;
  // Proactively create the Redis client so it begins connecting in the
  // background. We do NOT await a "connected" promise — ioredis connects
  // asynchronously and the 'ready' event (logged in config/redis.ts) fires
  // on its own. The app must still boot and serve requests via MongoDB
  // fallback if Redis is down; only Mongo connection failure is fatal.
  getRedis();
  connectMongo()
    .then(() => {
      app.listen(port, () => {
        console.log(`🚀 Gateway listening on :${port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start gateway:', err);
      process.exit(1);
    });
}

export default app;
