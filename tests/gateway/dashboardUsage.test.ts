import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { UsageLog } from '../../gateway/src/models/UsageLog.model';

import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import { rateLimitKey } from '../../gateway/src/utils/keys';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const redis = getRedis();
  await redis.ping();
  expect(redis.status).toBe('ready');
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();
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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupTenant(prefix: string) {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: uniqueEmail(prefix), password: 'password123' });

  expect(res.status).toBe(201);
  return {
    token: res.body.token as string,
    tenantId: res.body.tenant.id as string,
  };
}

describe('GET /dashboard/usage and GET /dashboard/limits', () => {
  it('returns zeros and empty arrays for a fresh tenant with no logs', async () => {
    const { token } = await signupTenant('fresh');

    const res = await request(app)
      .get('/dashboard/usage')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.totalRequests).toBe(0);
    expect(res.body.cacheHitRate).toBe(0);
    expect(res.body.averageLatencyMs).toBe(0);
    expect(Array.isArray(res.body.requestsOverTime)).toBe(true);
    expect(res.body.requestsOverTime.length).toBe(0);
    expect(Array.isArray(res.body.providerDistribution)).toBe(true);
    expect(res.body.providerDistribution[0].value).toBe(0);
    expect(res.body.providerDistribution[1].value).toBe(0);
  });

  it('strictly isolates tenant A data from tenant B', async () => {
    const tenantA = await signupTenant('tenantA');
    const tenantB = await signupTenant('tenantB');

    // Create 3 usage log entries for Tenant A
    await UsageLog.create({
      tenantId: tenantA.tenantId,
      timestamp: new Date(),
      endpoint: '/v1/chat/completions',
      provider: 'groq',
      cacheHit: false,
      tokensUsed: 50,
      latencyMs: 120,
      statusCode: 200,
    });

    await UsageLog.create({
      tenantId: tenantA.tenantId,
      timestamp: new Date(),
      endpoint: '/v1/chat/completions',
      provider: null,
      cacheHit: true,
      tokensUsed: 0,
      latencyMs: 5,
      statusCode: 200,
    });

    // Query Tenant A
    const resA = await request(app)
      .get('/dashboard/usage')
      .set('Authorization', `Bearer ${tenantA.token}`);

    expect(resA.status).toBe(200);
    expect(resA.body.totalRequests).toBe(2);
    expect(resA.body.cacheHitRate).toBe(50); // 1 hit / 2 total = 50%

    // Query Tenant B (should have 0 requests)
    const resB = await request(app)
      .get('/dashboard/usage')
      .set('Authorization', `Bearer ${tenantB.token}`);

    expect(resB.status).toBe(200);
    expect(resB.body.totalRequests).toBe(0);
    expect(resB.body.cacheHitRate).toBe(0);
    expect(resB.body.averageLatencyMs).toBe(0);
  });

  it('returns real sliding-window rate limit currentUsage count from Redis in GET /dashboard/limits', async () => {
    const tenant = await signupTenant('limits');
    const redis = getRedis();
    const key = rateLimitKey(tenant.tenantId);
    const now = Date.now();

    // Seed 7 rate-limit entries in Redis for this tenant
    const seedArgs: Array<string | number> = [];
    for (let i = 0; i < 7; i += 1) {
      seedArgs.push(now, `${now}:${i}`);
    }
    await redis.zadd(key, ...(seedArgs as [string | number, ...Array<string | number>]));

    const res = await request(app)
      .get('/dashboard/limits')
      .set('Authorization', `Bearer ${tenant.token}`);

    expect(res.status).toBe(200);
    expect(res.body.currentUsage).toBe(7);
    expect(res.body.rateLimitPerMin).toBeGreaterThan(0);
  });
});
