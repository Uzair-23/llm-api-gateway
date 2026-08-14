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
import { cacheKey, circuitStateKey, rateLimitKey } from '../../gateway/src/utils/keys';
import { hashPrompt } from '../../gateway/src/utils/promptHash.util';
import { completeWithGroq } from '../../gateway/src/services/upstream/groq.service';
import { completeWithGemini } from '../../gateway/src/services/upstream/gemini.service';
import * as circuitUtils from '../../gateway/src/utils/reportCircuitResult.util';

let mongoServer: MongoMemoryServer;
let fetchSpy: jest.SpiedFunction<typeof fetch>;

const mockedGroq = completeWithGroq as jest.MockedFunction<typeof completeWithGroq>;
const mockedGemini = completeWithGemini as jest.MockedFunction<typeof completeWithGemini>;

beforeAll(async () => {
  fetchSpy = jest.spyOn(global, 'fetch');

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const redis = getRedis();
  await redis.ping();
  expect(redis.status).toBe('ready');
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();

  const redis = getRedis();
  const [tenantKeys, rateKeys, cacheKeys, circuitKeys] = await Promise.all([
    redis.keys('tenant:*'),
    redis.keys('ratelimit:*'),
    redis.keys('cache:*'),
    redis.keys('circuit:*'),
  ]);

  const keysToDelete = [...tenantKeys, ...rateKeys, ...cacheKeys, ...circuitKeys];
  if (keysToDelete.length > 0) {
    await redis.del(...keysToDelete);
  }

  jest.clearAllMocks();
  fetchSpy.mockClear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
  fetchSpy.mockRestore();
});

function uniqueEmail(): string {
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupTenant() {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: uniqueEmail(), password: 'password123' });

  expect(res.status).toBe(201);
  return {
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

async function callChat(apiKey: string, body: Record<string, unknown>) {
  return request(app)
    .post('/v1/chat/completions')
    .set('Authorization', `Bearer ${apiKey}`)
    .send(body);
}

describe('/v1/chat/completions integration (auth -> rate limit -> cache -> fallback)', () => {
  afterEach(() => {
    // Provider modules are mocked, so no test in this suite should ever hit
    // real network APIs.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 200 from Groq and reports circuit success for groq', async () => {
    const apiKey = (await signupTenant()).apiKey;
    const successSpy = jest.spyOn(circuitUtils, 'reportCircuitSuccess');

    mockedGroq.mockResolvedValue({
      response: 'Groq answer',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      tokensUsed: 42,
    });

    const res = await callChat(apiKey, {
      prompt: 'hello',
      model: 'llama-3.1-8b-instant',
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('groq');
    expect(res.body.response).toBe('Groq answer');
    expect(successSpy).toHaveBeenCalledWith('groq');
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect(mockedGemini).not.toHaveBeenCalled();
  });

  it('falls back to Gemini when Groq fails and reports failure/success per provider', async () => {
    const apiKey = (await signupTenant()).apiKey;
    const successSpy = jest.spyOn(circuitUtils, 'reportCircuitSuccess');
    const failureSpy = jest.spyOn(circuitUtils, 'reportCircuitFailure');

    mockedGroq.mockRejectedValue(new Error('Groq provider failure'));
    mockedGemini.mockResolvedValue({
      response: 'Gemini fallback answer',
      model: 'gemini-1.5-flash',
      provider: 'gemini',
      tokensUsed: 11,
    });

    const res = await callChat(apiKey, {
      prompt: 'fallback please',
      model: 'gemini-1.5-flash',
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(failureSpy).toHaveBeenCalledWith('groq');
    expect(successSpy).toHaveBeenCalledWith('gemini');
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect(mockedGemini).toHaveBeenCalledTimes(1);
  });

  it('returns 503 AllProvidersUnavailable when both providers fail', async () => {
    const apiKey = (await signupTenant()).apiKey;

    mockedGroq.mockRejectedValue(new Error('Groq down'));
    mockedGemini.mockRejectedValue(new Error('Gemini down'));

    const res = await callChat(apiKey, {
      prompt: 'all down',
      model: 'any-model',
    });

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain('AllProvidersUnavailable');
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect(mockedGemini).toHaveBeenCalledTimes(1);
  });

  it('when Groq circuit is open, skips Groq call and goes directly to Gemini', async () => {
    const apiKey = (await signupTenant()).apiKey;
    const redis = getRedis();

    await redis.hset(
      circuitStateKey('groq'),
      'state',
      'open',
      'openedAt',
      String(Date.now()),
      'consecutiveSuccesses',
      '0',
      'trialInFlight',
      '0',
    );

    mockedGemini.mockResolvedValue({
      response: 'Gemini direct answer',
      model: 'gemini-1.5-flash',
      provider: 'gemini',
    });

    const res = await callChat(apiKey, {
      prompt: 'skip groq path',
      model: 'gemini-1.5-flash',
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('gemini');
    expect(mockedGroq).not.toHaveBeenCalled();
    expect(mockedGemini).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for invalid request body and calls neither provider', async () => {
    const apiKey = (await signupTenant()).apiKey;

    const res = await callChat(apiKey, {
      model: 'llama-3.1-8b-instant',
    });

    expect(res.status).toBe(400);
    expect(mockedGroq).not.toHaveBeenCalled();
    expect(mockedGemini).not.toHaveBeenCalled();
  });

  it('caches successful responses so the second identical request does not call providers again', async () => {
    const apiKey = (await signupTenant()).apiKey;
    const prompt = 'cache this';
    const model = 'llama-3.1-8b-instant';

    mockedGroq.mockResolvedValue({
      response: 'Cached value',
      model,
      provider: 'groq',
    });

    const first = await callChat(apiKey, { prompt, model });
    expect(first.status).toBe(200);
    expect(first.body.cacheHit).toBe(false);
    expect(mockedGroq).toHaveBeenCalledTimes(1);

    const redis = getRedis();
    const cachedPayload = await redis.get(cacheKey(hashPrompt(prompt, model)));
    expect(cachedPayload).not.toBeNull();

    const second = await callChat(apiKey, { prompt, model });
    expect(second.status).toBe(200);
    expect(second.body.cacheHit).toBe(true);
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect(mockedGemini).not.toHaveBeenCalled();
  });

  it('enforces rate limiting on /v1/chat/completions', async () => {
    const tenant = await signupTenant();
    const redis = getRedis();
    const key = rateLimitKey(tenant.tenantId);
    const now = Date.now();

    const seedArgs: Array<string | number> = [];
    for (let i = 0; i < 100; i += 1) {
      seedArgs.push(now, `${now}:${i}`);
    }
    await redis.zadd(key, ...(seedArgs as [string | number, ...Array<string | number>]));

    const res = await callChat(tenant.apiKey, {
      prompt: 'rate limit me',
      model: 'llama-3.1-8b-instant',
    });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Rate limit exceeded');
    expect(mockedGroq).not.toHaveBeenCalled();
    expect(mockedGemini).not.toHaveBeenCalled();
  });
});
