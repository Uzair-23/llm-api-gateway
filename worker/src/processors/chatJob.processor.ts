import { Job } from 'bullmq';
import { getRedis } from '../../../gateway/src/config/redis';
import { env } from '../../../gateway/src/config/env';
import { hashPrompt } from '../../../gateway/src/utils/promptHash.util';
import { cacheKey, jobResultKey } from '../../../gateway/src/utils/keys';
import { callWithFallback } from '../../../gateway/src/services/upstream';
import { UsageLog } from '../../../gateway/src/models/UsageLog.model';

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
 *  6. Record UsageLog asynchronously in a finally block
 *  7. Propagate errors so BullMQ marks failed jobs cleanly
 */
export async function processChatJob(job: Job<ChatJobData>): Promise<unknown> {
  const startTime = Date.now();
  const { prompt, model, tenantId } = job.data;
  const redis = getRedis();

  const hash = hashPrompt(prompt, model);
  const cKey = cacheKey(hash);

  let result: unknown;
  let cacheHit = false;
  let provider: 'groq' | 'gemini' | null = null;
  let tokensUsed = 0;
  let statusCode = 200;

  try {
    const cached = await redis.get(cKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      cacheHit = true;
      result = {
        ...parsed,
        cacheHit: true,
      };
    } else {
      const completion = await callWithFallback({ prompt, model });
      cacheHit = false;
      provider = (completion.provider as 'groq' | 'gemini') ?? null;
      tokensUsed = completion.tokensUsed ?? completion.usage?.total_tokens ?? 0;
      result = {
        ...completion,
        cacheHit: false,
      };

      await redis.set(cKey, JSON.stringify(completion), 'EX', env.CACHE_TTL_SECONDS);
    }

    if (job.id) {
      await redis.set(jobResultKey(job.id), JSON.stringify(result), 'EX', 600);
    }

    return result;
  } catch (err) {
    statusCode = 500;
    throw err;
  } finally {
    if (tenantId) {
      const latencyMs = Date.now() - startTime;
      UsageLog.create({
        tenantId,
        timestamp: new Date(),
        endpoint: '/v1/chat/completions?async=true',
        provider: cacheHit ? null : provider,
        cacheHit,
        tokensUsed,
        latencyMs,
        statusCode,
      }).catch((logErr) => {
        console.warn('Worker UsageLog write failed:', logErr);
      });
    }
  }
}
