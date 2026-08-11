import { Request, Response, NextFunction } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getRedis, isRedisAvailable } from '../config/redis';
import { rateLimitKey } from '../utils/keys';

/**
 * Sliding-window rate limiter middleware.
 *
 * Uses a Redis Lua script (EVAL/EVALSHA) for atomic check-and-increment.
 * The script evicts expired entries, counts the remaining ones, and either
 * adds the current request (if under limit) or denies it — all in a single
 * atomic Redis operation so concurrent requests can't race past the check.
 *
 * Algorithm: sliding-window LOG (sorted sets), NOT fixed-window.
 * Fixed-window allows up to 2x burst at window boundaries (e.g. 100 requests
 * at 11:59:59 + 100 at 12:00:01 = 200 in 2 seconds despite a "100/min" limit).
 * Sliding-window log doesn't have this flaw because the window is relative to
 * "now", not to a clock boundary.
 *
 * Failure mode: FAIL OPEN. If Redis is unreachable, the request is allowed
 * through (logged with [RATE-LIMITER-DEGRADED]) — we don't block all traffic
 * just because Redis had a blip. This is a deliberate tradeoff: availability
 * over strict rate enforcement during Redis outages.
 */

// Load the Lua script source once at module init (not per-request).
const luaScriptPath = join(__dirname, '..', 'lua', 'slidingWindowRateLimit.lua');
const luaScript = readFileSync(luaScriptPath, 'utf-8');

// SHA1 cache of the loaded script, populated lazily on first use.
let scriptSha: string | null = null;

/**
 * Execute the rate-limit Lua script using EVALSHA with a fallback to EVAL.
 *
 * The EVALSHA pattern avoids re-sending the full script body on every request
 * — Redis caches the script by its SHA1 hash, and we just send the hash.
 * If Redis was flushed (e.g. after a restart), the SHA won't be found and we
 * fall back to a full EVAL, which re-caches the script.
 */
async function evalRateLimitScript(
  redis: ReturnType<typeof getRedis>,
  key: string,
  nowMs: number,
  windowMs: number,
  maxRequests: number,
): Promise<[number, number, number]> {
  // Try EVALSHA first (fast path — only sends the hash, not the full script).
  if (scriptSha) {
    try {
      const result = await redis.evalsha(
        scriptSha,
        1,
        key,
        String(nowMs),
        String(windowMs),
        String(maxRequests),
      );
      return result as [number, number, number];
    } catch (err: unknown) {
      // NOSCRIPT error means Redis doesn't have this script cached (flushed,
      // restarted, etc.). Fall through to full EVAL below. Any other error
      // is a real failure — propagate it so the middleware can fail open.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('NOSCRIPT')) {
        throw err;
      }
    }
  }

  // Full EVAL (slow path — sends the entire script body). Redis caches it
  // automatically, so subsequent EVALSHA calls will work.
  const result = await redis.eval(
    luaScript,
    1,
    key,
    String(nowMs),
    String(windowMs),
    String(maxRequests),
  );

  // Cache the SHA for future EVALSHA calls. ioredis exposes `script` to load
  // a script and get its SHA; we compute it here to avoid an extra round trip.
  scriptSha = (await redis.script('LOAD', luaScript)) as string;

  return result as [number, number, number];
}

/**
 * Factory: create a rate-limiter middleware with the given limits.
 *
 * @param maxRequests  Maximum requests allowed in the window
 * @param windowSeconds  Window size in seconds
 * @returns Express middleware
 */
export function rateLimiter(maxRequests: number, windowSeconds: number) {
  const windowMs = windowSeconds * 1000;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) {
      // This middleware was mounted before the auth middleware — that's a
      // wiring bug, not a runtime condition. Fail loudly, don't silently no-op.
      throw new Error(
        'rateLimiter: req.tenant.tenantId is missing — ensure auth middleware runs before rateLimiter',
      );
    }

    // Fail open if Redis is not available.
    if (!isRedisAvailable()) {
      console.error('[RATE-LIMITER-DEGRADED] Redis unavailable — allowing request through (fail-open)');
      next();
      return;
    }

    const redis = getRedis();
    const key = rateLimitKey(tenantId);
    const nowMs = Date.now();

    try {
      const [allowed, count, oldestTs] = await evalRateLimitScript(
        redis,
        key,
        nowMs,
        windowMs,
        maxRequests,
      );

      if (allowed === 1) {
        // Request allowed — attach rate-limit headers.
        res.set('X-RateLimit-Limit', String(maxRequests));
        res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - count)));
        next();
        return;
      }

      // Request denied — calculate Retry-After from the oldest entry.
      // Retry-After = seconds until the oldest request in the window expires.
      // oldestTs is in ms; (oldestTs + windowMs) is when the oldest entry
      // falls out of the window. Convert the delta to seconds (ceil).
      let retryAfter = windowSeconds;
      if (oldestTs > 0) {
        const expiryMs = oldestTs + windowMs;
        const deltaMs = expiryMs - nowMs;
        retryAfter = Math.max(1, Math.ceil(deltaMs / 1000));
      }

      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded' });
    } catch (err) {
      // Redis errored during the script execution — fail open.
      console.error(
        '[RATE-LIMITER-DEGRADED] Redis error during rate-limit check — allowing request through (fail-open):',
        err instanceof Error ? err.message : err,
      );
      next();
    }
  };
}
