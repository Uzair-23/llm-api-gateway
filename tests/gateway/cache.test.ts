import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import { cacheKey, rateLimitKey } from '../../gateway/src/utils/keys';
import { hashPrompt } from '../../gateway/src/utils/promptHash.util';

// Env vars (JWT_SECRET, MONGO_URI, etc.) are set in tests/jest.setup.ts,
// which runs before this file is loaded.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Redis is required for these cache tests — fail fast if it isn't live.
  const redis = getRedis();
  await redis.ping();
  expect(redis.status).toBe('ready');
});

beforeEach(async () => {
  // Keep each test isolated: clear tenant auth cache, rate-limit counters,
  // and response cache entries.
  const redis = getRedis();
  const [tenantKeys, rateLimitKeys, cacheKeys] = await Promise.all([
    redis.keys('tenant:*'),
    redis.keys('ratelimit:*'),
    redis.keys('cache:*'),
  ]);

  const keysToDelete = [...tenantKeys, ...rateLimitKeys, ...cacheKeys];
  if (keysToDelete.length > 0) {
    await redis.del(...keysToDelete);
  }

  await mongoose.connection.db?.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

function uniqueEmail(): string {
  return `tenant-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupTenant() {
  const email = uniqueEmail();
  const res = await request(app)
    .post('/auth/signup')
    .send({ email, password: 'password123' });

  expect(res.status).toBe(201);
  return {
    email,
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

async function callCompletion(apiKey: string, prompt: string, model: string) {
  const startedAt = Date.now();
  const res = await request(app)
    .post('/v1/test-completion')
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ prompt, model });
  const elapsedMs = Date.now() - startedAt;
  return { res, elapsedMs };
}

describe('Response caching middleware', () => {
  it('first request is a miss, takes ~500ms, and stores the cache entry with a 1h TTL', async () => {
    const { apiKey } = await signupTenant();
    const prompt = 'Write a haiku about Redis';
    const model = 'groq';

    const { res, elapsedMs } = await callCompletion(apiKey, prompt, model);

    expect(res.status).toBe(200);
    expect(res.body.cacheHit).toBe(false);
    expect(res.body.response).toBe(`Simulated completion for: ${prompt}`);
    expect(elapsedMs).toBeGreaterThanOrEqual(400);

    const redis = getRedis();
    const ttl = await redis.ttl(cacheKey(hashPrompt(prompt, model)));
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('second identical request is a cache hit and returns quickly', async () => {
    const { apiKey } = await signupTenant();
    const prompt = 'Explain sliding-window rate limiting';
    const model = 'groq';

    const first = await callCompletion(apiKey, prompt, model);
    expect(first.res.status).toBe(200);
    expect(first.res.body.cacheHit).toBe(false);

    const second = await callCompletion(apiKey, prompt, model);
    expect(second.res.status).toBe(200);
    expect(second.res.body.cacheHit).toBe(true);
    expect(second.elapsedMs).toBeLessThan(50);
  });

  it('different prompt with same model produces a cache miss', async () => {
    const { apiKey } = await signupTenant();
    const model = 'groq';

    const first = await callCompletion(apiKey, 'Prompt A', model);
    expect(first.res.status).toBe(200);
    expect(first.res.body.cacheHit).toBe(false);

    const second = await callCompletion(apiKey, 'Prompt B', model);
    expect(second.res.status).toBe(200);
    expect(second.res.body.cacheHit).toBe(false);
    expect(second.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it('same prompt with different model produces a cache miss', async () => {
    const { apiKey } = await signupTenant();
    const prompt = 'Compare retries and retries';

    const first = await callCompletion(apiKey, prompt, 'groq');
    expect(first.res.status).toBe(200);
    expect(first.res.body.cacheHit).toBe(false);

    const second = await callCompletion(apiKey, prompt, 'gemini');
    expect(second.res.status).toBe(200);
    expect(second.res.body.cacheHit).toBe(false);
    expect(second.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it('shares the cache across tenants for identical prompt+model', async () => {
    const tenantA = await signupTenant();
    const tenantB = await signupTenant();
    const prompt = 'Shared cache should be global across tenants';
    const model = 'groq';

    const first = await callCompletion(tenantA.apiKey, prompt, model);
    expect(first.res.status).toBe(200);
    expect(first.res.body.cacheHit).toBe(false);

    const second = await callCompletion(tenantB.apiKey, prompt, model);
    expect(second.res.status).toBe(200);
    expect(second.res.body.cacheHit).toBe(true);
    expect(second.elapsedMs).toBeLessThan(50);
  });

  it('cache hits still count against the rate limiter when the cache middleware runs after rate limiting', async () => {
    const { apiKey } = await signupTenant();
    const prompt = 'Count me against rate limits even when cached';
    const model = 'groq';

    const first = await callCompletion(apiKey, prompt, model);
    expect(first.res.status).toBe(200);
    expect(first.res.body.cacheHit).toBe(false);

    // The route limit is 100/min. After the first uncached request, 99 more
    // cache hits should still be allowed. The next one should be rate limited.
    for (let i = 0; i < 99; i += 1) {
      const res = await callCompletion(apiKey, prompt, model);
      expect(res.res.status).toBe(200);
      expect(res.res.body.cacheHit).toBe(true);
    }

    const denied = await callCompletion(apiKey, prompt, model);
    expect(denied.res.status).toBe(429);
    expect(denied.res.body.error).toBe('Rate limit exceeded');
  });

  it('fails open when Redis errors and still serves the simulated upstream', async () => {
    const { apiKey } = await signupTenant();
    const prompt = 'Redis outage should not block requests';
    const model = 'groq';

    const redis = getRedis();
    const originalGet = redis.get.bind(redis);
    const originalSet = redis.set.bind(redis);

    const getSpy = jest.spyOn(redis, 'get').mockRejectedValue(new Error('Redis unavailable'));
    const setSpy = jest.spyOn(redis, 'set').mockRejectedValue(new Error('Redis unavailable'));

    try {
      const { res, elapsedMs } = await callCompletion(apiKey, prompt, model);
      expect(res.status).toBe(200);
      expect(res.body.cacheHit).toBe(false);
      expect(elapsedMs).toBeGreaterThanOrEqual(400);
      expect(res.body.response).toBe(`Simulated completion for: ${prompt}`);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
      redis.get = originalGet;
      redis.set = originalSet;
    }
  });
});
