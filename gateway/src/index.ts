import express, { Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { connectMongo } from './config/mongo';
import authRoutes from './routes/auth.routes';
import { errorHandler } from './middleware/errorHandler.middleware';

const app: Express = express();

app.use(cors());
app.use(express.json());

// Health check (public) — useful for Nginx/LB and for tests.
app.get('/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Auth routes mounted at /auth.
app.use('/auth', authRoutes);

// Centralized error handler — must be registered after all routes.
app.use(errorHandler);

if (env.NODE_ENV !== 'test') {
  const port = env.PORT;
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
