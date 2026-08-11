import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import express, { Express } from 'express';
import { Tenant } from '../../gateway/src/models/Tenant.model';
import { auth } from '../../gateway/src/middleware/auth.middleware';
import { rateLimiter } from '../../gateway/src/middleware/rateLimiter.middleware';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import { rateLimitKey } from '../../gateway/src/utils/keys';

// Env vars (JWT_SECRET, MONGO_URI, etc.) are set in tests/jest.setup.ts,
// which runs before this file is loaded.

let mongoServer: MongoMemoryServer;
let testApp: Express;

/**
 * Build a test Express app with auth + a configurable rate limiter.
 * Using a dedicated app (not the main gateway app) lets us set custom
 * limits per test without touching the hardcoded 5/60 on the real route.
 */
function buildApp(maxRequests: number, windowSeconds: number): Express {
  const app = express();
  app.use(express.json());
  app.get('/test-protected', auth, rateLimiter(maxRequests, windowSeconds), (req, res) => {
    res.json({ status: 'ok', tenantId: req.tenant?.tenantId });
  });
  return app;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Redis is a hard requirement for these tests — the whole point is proving
  // the Lua script's atomicity. Fail fast if Redis isn't live.
  const redis = getRedis();
  await redis.ping();
  expect(redis.status).toBe('ready');
});

beforeEach(async () => {
  await Tenant.deleteMany({});
  // Clear all rate-limit keys between tests so each starts with a clean counter.
  const redis = getRedis();
  const keys = await redis.keys('ratelimit:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

const validBody = { email: 'user@example.com', password: 'password123' };

/**
 * Helper: sign up a tenant and return the raw API key + tenant id.
 * Uses the main gateway app for signup, then uses the key against test apps.
 */
async function signupTenant(email = 'user@example.com') {
  // We need the main app for signup (it has /auth/signup). Import it here to
  // avoid a circular dependency at module load time.
  const { default: mainApp } = await import('../../gateway/src/index');
  const res = await request(mainApp)
    .post('/auth/signup')
    .send({ email, password: validBody.password });
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

describe('Sliding-window rate limiter', () => {
  it('allows requests under the limit and decrements X-RateLimit-Remaining', async () => {
    const { apiKey } = await signupTenant();
    testApp = buildApp(3, 60);

    const res1 = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe('3');
    expect(res1.headers['x-ratelimit-remaining']).toBe('2');

    const res2 = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('1');

    const res3 = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res3.status).toBe(200);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('passes the Nth request and denies the (N+1)th (off-by-one boundary)', async () => {
    const { apiKey } = await signupTenant();
    testApp = buildApp(3, 60);

    // 3 requests should all pass (limit = 3).
    for (let i = 0; i < 3; i++) {
      const res = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
      expect(res.status).toBe(200);
    }

    // The 4th request (N+1) must be denied.
    const res4 = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res4.status).toBe(429);
    expect(res4.body.error).toBe('Rate limit exceeded');
  });

  it('returns 429 with a reasonable Retry-After header (not 0, not full window)', async () => {
    const { apiKey } = await signupTenant();
    testApp = buildApp(2, 60);

    // Exhaust the limit.
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);

    // This one should be denied.
    const res = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    const retryAfter = parseInt(res.headers['retry-after'], 10);
    // Retry-After should be > 0 (not expired yet) and <= 60 (the window size).
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('enforces independent limits per tenant (multi-tenancy)', async () => {
    const tenantA = await signupTenant('tenant-a@example.com');
    const tenantB = await signupTenant('tenant-b@example.com');
    testApp = buildApp(2, 60);

    // Tenant A exhausts their limit.
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${tenantA.apiKey}`);
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${tenantA.apiKey}`);
    const aDenied = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${tenantA.apiKey}`);
    expect(aDenied.status).toBe(429);

    // Tenant B should still be allowed — their counter is independent.
    const bRes1 = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${tenantB.apiKey}`);
    expect(bRes1.status).toBe(200);

    // Verify the Redis keys are separate per tenant.
    const redis = getRedis();
    const aExists = await redis.exists(rateLimitKey(tenantA.tenantId));
    const bExists = await redis.exists(rateLimitKey(tenantB.tenantId));
    expect(aExists).toBe(1);
    expect(bExists).toBe(1);
  });

  it('resets the count after the window expires (sliding window)', async () => {
    const { apiKey } = await signupTenant();
    // Use a 2-second window for test speed.
    testApp = buildApp(2, 2);

    // Exhaust the limit.
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    const denied = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(denied.status).toBe(429);

    // Wait for the window to expire (2s window + 1s buffer).
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // After the window, requests should be allowed again.
    const res = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('fails open (allows request) when Redis errors, without rate-limit headers', async () => {
    const { apiKey } = await signupTenant();
    testApp = buildApp(1, 60);

    // Force a Redis error by mocking the eval/evalsha to throw.
    // We do this by temporarily replacing the Redis client's evalsha method.
    const redis = getRedis();
    const originalEvalsha = redis.evalsha.bind(redis);
    const originalEval = redis.eval.bind(redis);

    redis.evalsha = async () => {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    };
    redis.eval = async () => {
      throw new Error('Redis connection lost');
    };

    const res = await request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`);

    // Restore the original methods.
    redis.evalsha = originalEvalsha;
    redis.eval = originalEval;

    // Fail-open: request allowed through.
    expect(res.status).toBe(200);
    // No rate-limit headers since we couldn't actually check.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('allows EXACTLY 10 out of 20 concurrent requests (atomicity proof)', async () => {
    const { apiKey } = await signupTenant();
    testApp = buildApp(10, 60);

    // Fire 20 concurrent requests against a limit of 10.
    // If the Lua script is NOT atomic (e.g. separate GET-then-SET), more than
    // 10 would pass under concurrency because multiple requests would read
    // the same count before any of them increments.
    const promises = Array.from({ length: 20 }, () =>
      request(testApp).get('/test-protected').set('Authorization', `Bearer ${apiKey}`),
    );
    const results = await Promise.all(promises);

    const passed = results.filter((r) => r.status === 200).length;
    const denied = results.filter((r) => r.status === 429).length;

    expect(passed).toBe(10);
    expect(denied).toBe(10);
  });
});
