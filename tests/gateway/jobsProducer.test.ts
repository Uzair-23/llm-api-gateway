import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import { getQueue, closeQueue } from '../../gateway/src/config/queue';
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
  const keys = await redis.keys('*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  const queue = getQueue();
  try {
    await queue.obliterate({ force: true });
  } catch (_e) {
    // Ignore if queue wasn't populated or obliterated already
  }
});

afterAll(async () => {
  await closeQueue();
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

function uniqueEmail(): string {
  return `job-producer-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
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

describe('Async Queue Path (Producer & Polling)', () => {
  it('POST /v1/chat/completions?async=true with valid body returns 202 and a jobId', async () => {
    const { apiKey, tenantId } = await signupTenant();

    const res = await request(app)
      .post('/v1/chat/completions?async=true')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        prompt: 'Explain async queues in 5 words',
        model: 'llama-3.1-8b-instant',
      });

    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId.length).toBeGreaterThan(0);

    const queue = getQueue();
    const job = await queue.getJob(res.body.jobId);
    expect(job).not.toBeNull();
    expect(job?.data.prompt).toBe('Explain async queues in 5 words');
    expect(job?.data.model).toBe('llama-3.1-8b-instant');
    expect(job?.data.tenantId).toBe(tenantId);
  });

  it('POST /v1/chat/completions?async=true with invalid body returns 400 and enqueues no job', async () => {
    const { apiKey } = await signupTenant();
    const queue = getQueue();

    const initialJobs = await queue.getJobs();
    const initialCount = initialJobs.length;

    const res = await request(app)
      .post('/v1/chat/completions?async=true')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        model: 'llama-3.1-8b-instant',
        // missing prompt
      });

    expect(res.status).toBe(400);

    const currentJobs = await queue.getJobs();
    expect(currentJobs.length).toBe(initialCount);
  });

  it('Rate limit applies to async requests (429 when exceeded, no job enqueued)', async () => {
    const { apiKey, tenantId } = await signupTenant();
    const redis = getRedis();
    const queue = getQueue();
    const key = rateLimitKey(tenantId);
    const now = Date.now();

    // Fill up the 100 reqs limit
    const seedArgs: Array<string | number> = [];
    for (let i = 0; i < 100; i += 1) {
      seedArgs.push(now, `${now}:${i}`);
    }
    await redis.zadd(key, ...(seedArgs as [string | number, ...Array<string | number>]));

    const initialJobs = await queue.getJobs();
    const initialCount = initialJobs.length;

    const res = await request(app)
      .post('/v1/chat/completions?async=true')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        prompt: 'I am over rate limit',
        model: 'llama-3.1-8b-instant',
      });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Rate limit exceeded');

    const currentJobs = await queue.getJobs();
    expect(currentJobs.length).toBe(initialCount);
  });

  it('GET /v1/jobs/:jobId for a job that does not exist returns 404', async () => {
    const { apiKey } = await signupTenant();

    const res = await request(app)
      .get('/v1/jobs/non-existent-job-id-99999')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Job not found');
  });

  it('GET /v1/jobs/:jobId for a freshly enqueued job returns status waiting or active', async () => {
    const { apiKey } = await signupTenant();

    const enqueueRes = await request(app)
      .post('/v1/chat/completions?async=true')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        prompt: 'Check job status',
        model: 'llama-3.1-8b-instant',
      });

    expect(enqueueRes.status).toBe(202);
    const { jobId } = enqueueRes.body;

    const statusRes = await request(app)
      .get(`/v1/jobs/${jobId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.jobId).toBe(jobId);
    expect(['waiting', 'active', 'completed']).toContain(statusRes.body.status);
  });
});
