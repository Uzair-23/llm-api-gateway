import { Job } from 'bullmq';

jest.mock('../../../gateway/src/services/upstream/groq.service', () => ({
  completeWithGroq: jest.fn(),
}));

jest.mock('../../../gateway/src/services/upstream/gemini.service', () => ({
  completeWithGemini: jest.fn(),
}));

import { getRedis, disconnectRedis } from '../../../gateway/src/config/redis';
import { processChatJob, ChatJobData } from '../processors/chatJob.processor';
import { completeWithGroq } from '../../../gateway/src/services/upstream/groq.service';
import { completeWithGemini } from '../../../gateway/src/services/upstream/gemini.service';
import { cacheKey, jobResultKey } from '../../../gateway/src/utils/keys';
import { hashPrompt } from '../../../gateway/src/utils/promptHash.util';

const mockedGroq = completeWithGroq as jest.MockedFunction<typeof completeWithGroq>;
const mockedGemini = completeWithGemini as jest.MockedFunction<typeof completeWithGemini>;

describe('Worker processChatJob', () => {
  beforeAll(async () => {
    const redis = getRedis();
    await redis.ping();
    expect(redis.status).toBe('ready');
  });

  beforeEach(async () => {
    const redis = getRedis();
    const keys = await redis.keys('*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  function createMockJob(id: string, data: ChatJobData): Job<ChatJobData> {
    return {
      id,
      data,
    } as unknown as Job<ChatJobData>;
  }

  it('Cache miss: calls callWithFallback, caches response (3600s TTL), and saves result under job:{jobId}:result (600s TTL)', async () => {
    mockedGroq.mockResolvedValue({
      response: 'Groq async answer',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      tokensUsed: 15,
    });

    const job = createMockJob('job-101', {
      prompt: 'What is async processing?',
      model: 'llama-3.1-8b-instant',
      tenantId: 'tenant-abc',
    });

    const result = await processChatJob(job);

    expect(result).toEqual({
      response: 'Groq async answer',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      tokensUsed: 15,
      cacheHit: false,
    });
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect(mockedGemini).not.toHaveBeenCalled();

    const redis = getRedis();
    const cKey = cacheKey(hashPrompt('What is async processing?', 'llama-3.1-8b-instant'));
    const cachedStr = await redis.get(cKey);
    expect(cachedStr).not.toBeNull();

    const cacheTtl = await redis.ttl(cKey);
    expect(cacheTtl).toBeGreaterThan(0);
    expect(cacheTtl).toBeLessThanOrEqual(3600);

    const rKey = jobResultKey('job-101');
    const savedResultStr = await redis.get(rKey);
    expect(savedResultStr).not.toBeNull();
    expect(JSON.parse(savedResultStr!)).toEqual(result);

    const resultTtl = await redis.ttl(rKey);
    expect(resultTtl).toBeGreaterThan(0);
    expect(resultTtl).toBeLessThanOrEqual(600);
  });

  it('Cache hit: skips callWithFallback, returns cacheHit: true, and stores result under job:{jobId}:result', async () => {
    const redis = getRedis();
    const prompt = 'Pre-cached prompt';
    const model = 'llama-3.1-8b-instant';
    const cKey = cacheKey(hashPrompt(prompt, model));

    await redis.set(
      cKey,
      JSON.stringify({
        response: 'Previously cached answer',
        model,
        provider: 'groq',
      }),
    );

    const job = createMockJob('job-102', { prompt, model });

    const result = await processChatJob(job);

    expect(result).toEqual({
      response: 'Previously cached answer',
      model,
      provider: 'groq',
      cacheHit: true,
    });
    expect(mockedGroq).not.toHaveBeenCalled();
    expect(mockedGemini).not.toHaveBeenCalled();

    const rKey = jobResultKey('job-102');
    const savedResultStr = await redis.get(rKey);
    expect(savedResultStr).not.toBeNull();
    expect(JSON.parse(savedResultStr!)).toEqual(result);
  });

  it('Upstream failure: propagates error when both providers fail', async () => {
    mockedGroq.mockRejectedValue(new Error('Groq failed'));
    mockedGemini.mockRejectedValue(new Error('Gemini failed'));

    const job = createMockJob('job-103', {
      prompt: 'Failing prompt',
      model: 'llama-3.1-8b-instant',
    });

    await expect(processChatJob(job)).rejects.toThrow('AllProvidersUnavailable');
  });

  it('Single execution guarantee / duplicate request handling proof', async () => {
    mockedGroq.mockResolvedValue({
      response: 'Single execution answer',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
    });

    const job = createMockJob('job-104', {
      prompt: 'Single execution prompt',
      model: 'llama-3.1-8b-instant',
    });

    // Run processor first time (cache miss)
    const firstResult = await processChatJob(job);
    expect(mockedGroq).toHaveBeenCalledTimes(1);

    // Run processor second time with same prompt (cache hit)
    const secondResult = await processChatJob(job);

    // Groq service was called exactly ONCE across both invocations
    expect(mockedGroq).toHaveBeenCalledTimes(1);
    expect((firstResult as { cacheHit: boolean }).cacheHit).toBe(false);
    expect((secondResult as { cacheHit: boolean }).cacheHit).toBe(true);
  });
});
