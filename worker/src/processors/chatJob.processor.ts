import { Job } from 'bullmq';
import { getRedis } from '../../../gateway/src/config/redis';
import { env } from '../../../gateway/src/config/env';
import { hashPrompt } from '../../../gateway/src/utils/promptHash.util';
import { cacheKey, jobResultKey } from '../../../gateway/src/utils/keys';
import { callWithFallback } from '../../../gateway/src/services/upstream';

export interface ChatJobData {
  prompt: string;
  model: string;
  tenantId?: string;
}

/**
 * BullMQ Job Processor for async chat completion jobs ('llm-jobs' queue).
 *
 * Steps:
 *  1. Extract { prompt, model, tenantId } from job.data
 *  2. Check Redis cache cache:{sha256(prompt+model)}
 *  3. On cache hit: return cached completion with cacheHit: true
 *  4. On cache miss: execute callWithFallback({ prompt, model }) (Groq/Gemini circuit breaker flow),
 *     cache response for 1 hour (3600s)
 *  5. Store final result at job:{jobId}:result with 10-minute (600s) TTL
 *  6. Propagate errors so BullMQ marks failed jobs cleanly
 */
export async function processChatJob(job: Job<ChatJobData>): Promise<unknown> {
  const { prompt, model } = job.data;
  const redis = getRedis();

  const hash = hashPrompt(prompt, model);
  const cKey = cacheKey(hash);

  const cached = await redis.get(cKey);
  let result: unknown;

  if (cached) {
    const parsed = JSON.parse(cached);
    result = {
      ...parsed,
      cacheHit: true,
    };
  } else {
    const completion = await callWithFallback({ prompt, model });
    result = {
      ...completion,
      cacheHit: false,
    };

    // Cache response for 1 hour (3600s) per PRD
    await redis.set(cKey, JSON.stringify(completion), 'EX', env.CACHE_TTL_SECONDS);
  }

  // Store final result in Redis at job:{jobId}:result with 10-minute (600s) TTL
  if (job.id) {
    await redis.set(jobResultKey(job.id), JSON.stringify(result), 'EX', 600);
  }

  return result;
}
