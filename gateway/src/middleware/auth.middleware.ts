import { Request, Response, NextFunction } from 'express';
import { Tenant } from '../models/Tenant.model';
import { hashApiKey } from '../utils/apiKey';
import { tenantByApiKeyHashKey } from '../utils/keys';
import { getRedis, isRedisAvailable } from '../config/redis';
import { UnauthorizedError } from '../utils/errors';

/**
 * Cache-aside tenant lookup shape stored in Redis under `tenant:{sha256Hash}`.
 * Only the fields needed by downstream middleware/handlers are cached — never
 * the passwordHash or the raw key.
 */
interface CachedTenant {
  tenantId: string;
  planTier: 'free' | 'pro';
  rateLimitPerMin: number;
}

const CACHE_TTL_SECONDS = 300; // 5 minutes per the PRD request flow.

/**
 * API-key auth middleware for gateway traffic (machine-to-machine).
 *
 * Flow:
 *  1. Extract `Authorization: Bearer <rawKey>`. Missing/malformed → 401.
 *  2. SHA256-hash the inbound raw key (deterministic — same key → same hash).
 *  3. Redis cache-aside: GET `tenant:{hash}`.
 *     - HIT: parse cached tenant, attach to `req.tenant`, next(). No Mongo hit.
 *     - MISS: query MongoDB by `apiKeyHash`. Not found → 401. Found → cache
 *       the tenant JSON in Redis with a 5-min TTL, attach to `req.tenant`,
 *       next().
 *
 * If Redis is unavailable (not connected / errored), the middleware degrades
 * gracefully to a direct MongoDB lookup on every request — correctness is
 * preserved, only the cache benefit is lost. This keeps tests runnable
 * without a Redis server.
 */
export async function auth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid API key');
    }

    const rawKey = header.slice('Bearer '.length).trim();
    if (!rawKey) {
      throw new UnauthorizedError('Missing or invalid API key');
    }

    const hash = hashApiKey(rawKey);
    const cacheKey = tenantByApiKeyHashKey(hash);

    // --- Cache-aside: try Redis first ---
    if (isRedisAvailable()) {
      try {
        const cached = await getRedis().get(cacheKey);
        if (cached) {
          const tenant: CachedTenant = JSON.parse(cached);
          req.tenant = {
            tenantId: tenant.tenantId,
            planTier: tenant.planTier,
            rateLimitPerMin: tenant.rateLimitPerMin,
          };
          next();
          return;
        }
      } catch (redisErr) {
        // Redis errored — log and fall through to MongoDB. Don't fail the
        // request just because the cache is down.
        console.error('Redis cache lookup failed, falling back to MongoDB:', redisErr);
      }
    }

    // --- Cache MISS (or Redis unavailable): query MongoDB ---
    const tenant = await Tenant.findOne({ apiKeyHash: hash }).lean();
    if (!tenant) {
      throw new UnauthorizedError('Invalid API key');
    }

    const cachedTenant: CachedTenant = {
      tenantId: tenant._id.toString(),
      planTier: tenant.planTier,
      rateLimitPerMin: tenant.rateLimitPerMin,
    };

    req.tenant = {
      tenantId: cachedTenant.tenantId,
      planTier: cachedTenant.planTier,
      rateLimitPerMin: cachedTenant.rateLimitPerMin,
    };

    // Populate the cache (best-effort; a failure here doesn't break the request).
    if (isRedisAvailable()) {
      try {
        await getRedis().set(cacheKey, JSON.stringify(cachedTenant), 'EX', CACHE_TTL_SECONDS);
      } catch (redisErr) {
        console.error('Redis cache write failed:', redisErr);
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}
