import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { Tenant } from '../../gateway/src/models/Tenant.model';
import { tenantByApiKeyHashKey } from '../../gateway/src/utils/keys';
import { hashApiKey } from '../../gateway/src/utils/apiKey';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';

// Env vars (JWT_SECRET, MONGO_URI, etc.) are set in tests/jest.setup.ts,
// which runs before this file is loaded — the app import below triggers
// zod env validation at module-load time.

let mongoServer: MongoMemoryServer;
let redisAvailable = false;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Try to connect to Redis (available in the dev env via docker-compose).
  // If it's not reachable, the auth middleware degrades to MongoDB-only and
  // the cache-hit test is skipped — but the auth-correctness tests still run.
  try {
    const redis = getRedis();
    await redis.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  }
});

beforeEach(async () => {
  await Tenant.deleteMany({});
  if (redisAvailable) {
    // Flush only tenant:* keys to avoid clobbering unrelated state.
    const redis = getRedis();
    const keys = await redis.keys('tenant:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

const validBody = { email: 'user@example.com', password: 'password123' };

/**
 * Helper: sign up and return the raw API key + tenant id.
 */
async function signupAndGetKey() {
  const res = await request(app).post('/auth/signup').send(validBody);
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

const PROTECTED = '/v1/health/protected';

describe('API-key auth middleware (cache-aside)', () => {
  it('returns 200 on first request with a valid key (MongoDB hit)', async () => {
    const { apiKey, tenantId } = await signupAndGetKey();

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(tenantId);

    // After the first request, the Redis cache entry should exist (proving
    // the miss path populated the cache).
    if (redisAvailable) {
      const hash = hashApiKey(apiKey);
      const cached = await getRedis().get(tenantByApiKeyHashKey(hash));
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed.tenantId).toBe(tenantId);
    }
  });

  it('does NOT hit MongoDB on the second request within TTL (cache hit)', async () => {
    if (!redisAvailable) {
      // Without Redis there's no cache, so this test can't prove cache-aside.
      console.warn('Skipping cache-hit test: Redis not available');
      return;
    }

    const { apiKey, tenantId } = await signupAndGetKey();

    // Spy on Tenant.findOne AFTER signup so signup's own findOne (duplicate
    // email check) isn't counted. We only care about auth-middleware calls.
    const findOneSpy = jest.spyOn(Tenant, 'findOne');

    // First request: cache miss → must hit MongoDB.
    const res1 = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res1.status).toBe(200);
    expect(findOneSpy).toHaveBeenCalledTimes(1);

    // Second request: cache hit → must NOT hit MongoDB.
    const res2 = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res2.status).toBe(200);
    expect(res2.body.tenantId).toBe(tenantId);
    // The spy count must still be 1 — this is the actual proof cache-aside
    // works, not an assumption.
    expect(findOneSpy).toHaveBeenCalledTimes(1);

    findOneSpy.mockRestore();
  });

  it('returns 401 for an invalid (well-formed but wrong) API key', async () => {
    await signupAndGetKey();

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', 'Bearer sk-live-deadbeefdeadbeefdeadbeefdeadbeef');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid api key/i);
  });

  it('returns 401 when the Authorization header is missing', async () => {
    await signupAndGetKey();

    const res = await request(app).get(PROTECTED);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing or invalid api key/i);
  });

  it('returns 401 for a malformed header (missing "Bearer" prefix)', async () => {
    await signupAndGetKey();

    const res = await request(app)
      .get(PROTECTED)
      .set('Authorization', 'sk-live-something');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing or invalid api key/i);
  });

  it('rotated key: OLD key fails (401), NEW key succeeds (200)', async () => {
    const { apiKey } = await signupAndGetKey();

    // Log in to get a JWT for the rotate endpoint.
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: validBody.email, password: validBody.password });
    expect(loginRes.status).toBe(200);
    const jwt = loginRes.body.token as string;

    // Old key works before rotation.
    const before = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(200);

    // Rotate.
    const rotateRes = await request(app)
      .post('/auth/api-key/rotate')
      .set('Authorization', `Bearer ${jwt}`)
      .send();
    expect(rotateRes.status).toBe(200);
    const newKey = rotateRes.body.apiKey as string;

    // Old key must immediately fail.
    const oldAfter = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${apiKey}`);
    expect(oldAfter.status).toBe(401);

    // New key must succeed.
    const newAfter = await request(app)
      .get(PROTECTED)
      .set('Authorization', `Bearer ${newKey}`);
    expect(newAfter.status).toBe(200);
  });
});
