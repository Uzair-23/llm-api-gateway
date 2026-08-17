import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

jest.mock('../../gateway/src/services/upstream/groq.service', () => ({
  completeWithGroq: jest.fn(),
}));

jest.mock('../../gateway/src/services/upstream/gemini.service', () => ({
  completeWithGemini: jest.fn(),
}));

import app from '../../gateway/src/index';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import { rateLimitKey } from '../../gateway/src/utils/keys';
import { completeWithGroq } from '../../gateway/src/services/upstream/groq.service';
import { UsageLog } from '../../gateway/src/models/UsageLog.model';

let mongoServer: MongoMemoryServer;
const mockedGroq = completeWithGroq as jest.MockedFunction<typeof completeWithGroq>;

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
  const keys = await redis.keys('*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

function uniqueEmail(): string {
  return `playground-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupTenant() {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: uniqueEmail(), password: 'password123' });

  expect(res.status).toBe(201);
  return {
    token: res.body.token as string,
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

describe('POST /dashboard/playground', () => {
  it('returns 401 when Authorization header is missing or invalid', async () => {
    const res = await request(app)
      .post('/dashboard/playground')
      .send({ prompt: 'Hello', model: 'llama-3.1-8b-instant' });

    expect(res.status).toBe(401);

    const resInvalid = await request(app)
      .post('/dashboard/playground')
      .set('Authorization', 'Bearer invalid-jwt-token')
      .send({ prompt: 'Hello', model: 'llama-3.1-8b-instant' });

    expect(resInvalid.status).toBe(401);
  });

  it('returns 200 and completion payload with valid JWT and logs endpoint as /dashboard/playground', async () => {
    const { token, tenantId } = await signupTenant();
    const usageLogSpy = jest.spyOn(UsageLog, 'create').mockImplementation(() => Promise.resolve({} as any));

    mockedGroq.mockResolvedValue({
      response: 'Playground answer',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      tokensUsed: 18,
    });

    const res = await request(app)
      .post('/dashboard/playground')
      .set('Authorization', `Bearer ${token}`)
      .send({ prompt: 'Test playground prompt', model: 'llama-3.1-8b-instant' });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('Playground answer');
    expect(res.body.provider).toBe('groq');
    expect(res.body.cacheHit).toBe(false);

    expect(usageLogSpy).toHaveBeenCalled();
    const logArg = usageLogSpy.mock.calls[0][0] as any;
    expect(logArg.tenantId.toString()).toBe(tenantId);
    expect(logArg.endpoint).toBe('/dashboard/playground');
    expect(logArg.provider).toBe('groq');

    usageLogSpy.mockRestore();
  });

  it('shares the exact same Redis rate limit quota with /v1/chat/completions', async () => {
    const tenant = await signupTenant();
    const redis = getRedis();
    const key = rateLimitKey(tenant.tenantId);
    const now = Date.now();

    // Exhaust 100 requests in Redis for this tenant
    const seedArgs: Array<string | number> = [];
    for (let i = 0; i < 100; i += 1) {
      seedArgs.push(now, `${now}:${i}`);
    }
    await redis.zadd(key, ...(seedArgs as [string | number, ...Array<string | number>]));

    // Hitting /dashboard/playground with JWT should now fail with 429
    const playgroundRes = await request(app)
      .post('/dashboard/playground')
      .set('Authorization', `Bearer ${tenant.token}`)
      .send({ prompt: 'Over limit playground', model: 'llama-3.1-8b-instant' });

    expect(playgroundRes.status).toBe(429);
    expect(playgroundRes.body.error).toBe('Rate limit exceeded');

    // Hitting /v1/chat/completions with API key should also fail with 429
    const apiRes = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${tenant.apiKey}`)
      .send({ prompt: 'Over limit api key', model: 'llama-3.1-8b-instant' });

    expect(apiRes.status).toBe(429);
    expect(apiRes.body.error).toBe('Rate limit exceeded');
    expect(mockedGroq).not.toHaveBeenCalled();
  });
});
