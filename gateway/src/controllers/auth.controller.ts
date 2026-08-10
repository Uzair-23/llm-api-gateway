import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { Tenant } from '../models/Tenant.model';
import { signupBodySchema, loginBodySchema } from '../validation/auth.validation';
import { signToken } from '../utils/jwt';
import { ConflictError, UnauthorizedError, NotFoundError } from '../utils/errors';
import { generateApiKey } from '../utils/apiKey';
import { tenantByApiKeyHashKey } from '../utils/keys';
import { getRedis, isRedisAvailable } from '../config/redis';

/**
 * Public tenant info returned in auth responses.
 * `passwordHash`, `apiKeyHash`, and `apiKeyPrefix` are deliberately excluded —
 * never leak credentials or their hashes on the wire.
 */
function publicTenant(t: { _id: import('mongoose').Types.ObjectId; email: string; planTier: 'free' | 'pro'; rateLimitPerMin: number; createdAt: Date }) {
  return {
    id: t._id.toString(),
    email: t.email,
    planTier: t.planTier,
    rateLimitPerMin: t.rateLimitPerMin,
    createdAt: t.createdAt,
  };
}

/**
 * POST /auth/signup
 * Validates input, rejects duplicate emails with 409, hashes the password
 * with bcrypt (12 salt rounds), generates an initial API key, persists the
 * Tenant, and returns a JWT + tenant info + the RAW API key.
 *
 * The raw API key is returned here ONCE — this is the only time it is ever
 * shown to the user (same pattern as AWS / Stripe API keys). It is never
 * stored in plaintext anywhere; only its bcrypt hash is persisted. If the
 * user loses it they must rotate via /auth/api-key/rotate, which generates a
 * new key and immediately invalidates the old one.
 */
export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = signupBodySchema.parse(req.body);
    const { email, password } = parsed;

    const existing = await Tenant.findOne({ email });
    if (existing) {
      throw new ConflictError('A tenant with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { rawKey, prefix, hash: apiKeyHash } = generateApiKey();

    const tenant = await Tenant.create({
      email,
      passwordHash,
      apiKeyHash,
      apiKeyPrefix: prefix,
    });

    const token = signToken({ tenantId: tenant._id.toString(), email: tenant.email });
    // One-time display of the raw API key — never retrievable again.
    res.status(201).json({ token, tenant: publicTenant(tenant), apiKey: rawKey });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/login
 * Validates input, looks up the tenant by email, and compares the supplied
 * password with the stored bcrypt hash.
 *
 * SECURITY: "user not found" and "wrong password" both return the SAME 401
 * message ("Invalid email or password"). Returning distinct messages would
 * let an attacker enumerate which emails are registered (user enumeration),
 * which is a real attack vector against auth systems. The cost of this
 * choice is a slightly worse UX for legitimate users who typo their email,
 * which is the correct tradeoff for a credential endpoint.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = loginBodySchema.parse(req.body);
    const { email, password } = parsed;

    const tenant = await Tenant.findOne({ email });
    if (!tenant) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const match = await bcrypt.compare(password, tenant.passwordHash);
    if (!match) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const token = signToken({ tenantId: tenant._id.toString(), email: tenant.email });
    res.status(200).json({ token, tenant: publicTenant(tenant) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/api-key/rotate  (JWT-protected)
 *
 * Generates a new API key for the authenticated tenant, overwrites the
 * stored `apiKeyHash` + `apiKeyPrefix`, and immediately invalidates the old
 * key. There is no grace period in v1 — once rotated, the old key is dead.
 *
 * The new raw key is returned ONCE (same one-time-display pattern as signup).
 *
 * CACHE INVALIDATION: the API-key auth middleware (Phase 2, Prompt B) caches
 * tenant lookups in Redis under `tenant:{apiKeyHash}` with a 5-min TTL. After
 * rotating we MUST delete the cache entry for the OLD hash, otherwise the old
 * key stays valid until its TTL expires — a security bug. The Redis client
 * singleton lives in gateway/src/config/redis.ts; until that module + the
 * auth middleware exist, this is a TODO. See `invalidateOldKeyCache` below.
 */
export async function rotateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) {
      // Should be unreachable — jwtAuth guarantees req.tenant — but guard anyway.
      throw new UnauthorizedError('Authentication required');
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      throw new NotFoundError('Tenant not found');
    }

    const oldApiKeyHash = tenant.apiKeyHash;

    const { rawKey, prefix, hash: newApiKeyHash } = generateApiKey();
    tenant.apiKeyHash = newApiKeyHash;
    tenant.apiKeyPrefix = prefix;
    await tenant.save();

    // Invalidate the Redis cache entry for the OLD key hash so the previous
    // key stops authenticating immediately — without this, the old key stays
    // valid for up to its 5-min cache TTL, which is a security bug.
    await invalidateOldKeyCache(oldApiKeyHash);

    res.status(200).json({ apiKey: rawKey });
  } catch (err) {
    next(err);
  }
}

/**
 * Cache invalidation for a rotated API key hash.
 *
 * Deletes `tenant:{oldHash}` from Redis so the old key can't be used again
 * during its TTL window. If Redis is unavailable this is a no-op (the cache
 * entry simply doesn't exist), so the rotate endpoint stays usable in tests
 * without a Redis server.
 */
async function invalidateOldKeyCache(oldApiKeyHash: string): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }
  try {
    await getRedis().del(tenantByApiKeyHashKey(oldApiKeyHash));
  } catch (err) {
    // Log but don't fail the rotation — the Mongo write already succeeded.
    console.error('Failed to invalidate old API key cache:', err);
  }
}
