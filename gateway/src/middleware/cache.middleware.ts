import { Request, Response, NextFunction } from 'express';
import { getRedis, isRedisAvailable } from '../config/redis';
import { cacheKey } from '../utils/keys';
import { hashPrompt } from '../utils/promptHash.util';

/**
 * Response caching middleware (cache-aside pattern).
 *
 * Runs AFTER auth + rate limiting in the chain. A cache hit still counts
 * against the tenant's rate limit because rate limiting executes first —
 * this is intentional: tenants can't bypass rate limits by replaying cached
 * prompts.
 *
 * Cache key: SHA256 of JSON.stringify({ prompt, model }) — shared across
 * tenants (same prompt+model = same LLM response, not tenant-specific data).
 *
 * Only caches successful (2xx) responses. TTL: 3600s (1 hour) per PRD.md.
 *
 * Failure mode: FAIL OPEN. If Redis is unreachable, caching is skipped
 * entirely and the request proceeds to the upstream handler. Caching is a
 * performance optimization, not correctness-critical, so it should never
 * block traffic.
 */

const CACHE_TTL_SECONDS = 3600;

function stripCacheHit<T>(body: T): T {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const cachedBody = { ...(body as Record<string, unknown>) };
    delete cachedBody.cacheHit;
    return cachedBody as T;
  }

  return body;
}

/**
 * Cache middleware. Intercepts the response via res.json override to
 * capture successful payloads and write them to Redis.
 */
export async function cache(req: Request, res: Response, next: NextFunction): Promise<void> {
  const prompt = req.body?.prompt;
  const model = req.body?.model;

  // If prompt or model is missing, skip caching entirely — this middleware
  // shouldn't be a hard dependency on request shape until Phase 6 finalizes
  // the real endpoint contract.
  if (!prompt || !model) {
    next();
    return;
  }

  const hash = hashPrompt(prompt, model);
  const redisKey = cacheKey(hash);

  // Fail open if Redis is not available.
  if (!isRedisAvailable()) {
    console.error('[CACHE-DEGRADED] Redis unavailable — skipping cache lookup');
    next();
    return;
  }

  const redis = getRedis();

  // --- Cache lookup ---
  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      // Cache HIT: respond immediately with the cached body + cacheHit: true.
      // Do NOT call next() — this short-circuits before the upstream handler.
      const body = JSON.parse(cached);
      res.json({ ...body, cacheHit: true });
      return;
    }
  } catch (err) {
    console.error('[CACHE-DEGRADED] Redis error during cache lookup:', err instanceof Error ? err.message : err);
    next();
    return;
  }

  // --- Cache MISS: intercept the response and cache it on success ---
  // Store the hash so downstream handlers (or a post-response hook) know
  // this request is cacheable.
  res.locals.cacheKeyHash = hash;

  // Override res.json to capture the payload before it's sent. After
  // capturing, if the status is 2xx, write the body to Redis (WITHOUT the
  // cacheHit field — that's added fresh on each hit). Then call the
  // original res.json to actually send the response to the client.
  const originalJson = res.json.bind(res);
  res.json = (async function (body: unknown): Promise<Response> {
    // Restore the original res.json immediately so we don't double-send
    // or interfere with any subsequent res.json calls.
    res.json = originalJson;

    // Only cache successful responses (2xx).
    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Write to Redis before responding so TTL checks are deterministic in
      // tests and the cached entry is present immediately after the response.
      if (isRedisAvailable()) {
        try {
          await redis.set(redisKey, JSON.stringify(stripCacheHit(body)), 'EX', CACHE_TTL_SECONDS);
        } catch (err) {
          console.error('[CACHE-DEGRADED] Redis error during cache write:', err instanceof Error ? err.message : err);
        }
      }
    }

    // Send the response to the client with cacheHit: false (this was a miss).
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return originalJson({ ...(body as Record<string, unknown>), cacheHit: false });
    }

    return originalJson(body as never);
  }) as unknown as typeof res.json;

  next();
}
