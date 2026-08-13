import express, { Express } from 'express';
import cors from 'cors';
import { env } from './config/env';
import { connectMongo } from './config/mongo';
import { getRedis } from './config/redis';
import authRoutes from './routes/auth.routes';
import { errorHandler } from './middleware/errorHandler.middleware';
import { auth } from './middleware/auth.middleware';
import { rateLimiter } from './middleware/rateLimiter.middleware';
import { cache } from './middleware/cache.middleware';
import { circuitBreaker } from './middleware/circuitBreaker.middleware';
import {
  CircuitBreakerConfig,
  DEFAULT_CIRCUIT_CONFIG,
  reportCircuitFailure,
  reportCircuitSuccess,
  resetCircuit,
} from './utils/reportCircuitResult.util';
import { circuitFailuresKey, circuitStateKey, circuitUpstreamCallsKey } from './utils/keys';
// Side-effect import: augments Express Request with `req.tenant` for jwtAuth.
import './types/request.types';

const app: Express = express();

const testCircuitConfig: CircuitBreakerConfig =
  env.NODE_ENV === 'test'
    ? {
      // Short test windows keep Jest fast while preserving production logic.
      failureThreshold: 3,
      failureWindowMs: 2_000,
      cooldownMs: 3_000,
    }
    : DEFAULT_CIRCUIT_CONFIG;

const testCircuitProviders = ['test-provider'];

app.use(cors());
app.use(express.json());

// Health check (public) — useful for Nginx/LB and for tests.
app.get('/v1/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Temporary API-key-protected route for testing auth + rate limiting in
// isolation before Phase 6 wires them onto /v1/chat/completions.
app.get('/v1/health/protected', auth, rateLimiter(100, 60), (req, res) => {
  res.json({ status: 'ok', tenantId: req.tenant?.tenantId });
});

// Temporary simulated upstream route for proving response caching before
// Phase 6 exists. Remove/replace this with /v1/chat/completions when the real
// Groq/Gemini integration lands.
app.post('/v1/test-completion', auth, rateLimiter(100, 60), cache, async (req, res) => {
  const prompt = req.body?.prompt as string;
  const model = req.body?.model as string;

  await new Promise((resolve) => setTimeout(resolve, 500));

  res.json({
    response: `Simulated completion for: ${prompt}`,
    model,
    cacheHit: false,
  });
});

// Temporary simulated-upstream route for Phase 5 circuit-breaker validation.
// Remove/replace this route in Phase 6 when /v1/chat/completions is wired to
// real Groq/Gemini calls with reportCircuitSuccess/reportCircuitFailure.
app.post(
  '/v1/test-circuit',
  auth,
  rateLimiter(100, 60),
  circuitBreaker('test-provider', testCircuitConfig),
  async (req, res) => {
    const provider = 'test-provider';
    const forceFailure = Boolean(req.body?.forceFailure);
    const simulatedDelayMs = Number(req.body?.simulatedDelayMs ?? 0);
    try {
      await getRedis().incr(circuitUpstreamCallsKey(provider));
    } catch (err) {
      console.error(
        '[CIRCUIT-DEGRADED] Failed to increment simulated upstream counter:',
        err instanceof Error ? err.message : err,
      );
    }

    if (forceFailure) {
      if (simulatedDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));
      }

      try {
        await reportCircuitFailure(provider, testCircuitConfig);
      } catch (err) {
        console.error(
          '[CIRCUIT-DEGRADED] Failed to report simulated upstream failure:',
          err instanceof Error ? err.message : err,
        );
      }

      res.status(502).json({ error: 'Simulated upstream failure', provider });
      return;
    }

    if (simulatedDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));
    }

    try {
      await reportCircuitSuccess(provider, testCircuitConfig);
    } catch (err) {
      console.error(
        '[CIRCUIT-DEGRADED] Failed to report simulated upstream success:',
        err instanceof Error ? err.message : err,
      );
    }

    res.status(200).json({ response: 'Simulated success', provider });
  },
);

// TODO (Phase 6+/dashboard hardening): protect admin routes with JWT + admin role.
app.get('/admin/circuit-status', async (_req, res, next) => {
  try {
    const providers = testCircuitProviders;

    if (!providers.length) {
      res.json({ providers: [] });
      return;
    }

    const redis = getRedis();
    const nowMs = Date.now();
    const windowStart = nowMs - testCircuitConfig.failureWindowMs;

    const results = await Promise.all(
      providers.map(async (provider) => {
        const stateKey = circuitStateKey(provider);
        const failuresKey = circuitFailuresKey(provider);
        const upstreamCallsKey = circuitUpstreamCallsKey(provider);

        // Keep reported failure counts aligned to the configured window.
        await redis.zremrangebyscore(failuresKey, '-inf', windowStart);

        const [[state, openedAt, consecutiveSuccesses, trialInFlight], failureCount, upstreamCalls] = await Promise.all([
          redis.hmget(stateKey, 'state', 'openedAt', 'consecutiveSuccesses', 'trialInFlight'),
          redis.zcard(failuresKey),
          redis.get(upstreamCallsKey),
        ]);

        return {
          provider,
          state: state ?? 'closed',
          openedAt: Number(openedAt ?? 0),
          consecutiveSuccesses: Number(consecutiveSuccesses ?? 0),
          trialInFlight: Number(trialInFlight ?? 0),
          failureCount,
          upstreamCalls: Number(upstreamCalls ?? 0),
        };
      }),
    );

    res.json({ providers: results });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/circuit/reset', async (req, res, next) => {
  try {
    const provider = String(req.body?.provider ?? '').trim();

    if (!provider) {
      res.status(400).json({ error: 'provider is required' });
      return;
    }

    await resetCircuit(provider);
    res.json({ ok: true, provider, state: 'closed' });
  } catch (err) {
    next(err);
  }
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
