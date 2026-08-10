import crypto from 'crypto';

/**
 * API key generation + hashing utilities.
 *
 * Raw key format: `sk-live-${32 hex chars}` (16 random bytes → 32 hex chars).
 * Only a SHA256 hash of the raw key is ever persisted; the raw key is shown to
 * the user exactly once at creation/rotation time (same pattern as AWS/Stripe
 * API keys) and never retrievable again.
 */

const KEY_PREFIX_LITERAL = 'sk-live-';

export interface GeneratedApiKey {
  /** The full raw key. Returned to the client ONCE; never stored. */
  rawKey: string;
  /** First 12 chars of the raw key, stored for dashboard display. */
  prefix: string;
  /** SHA256 hex digest of the raw key. Persisted; used as a Redis lookup key. */
  hash: string;
}

/**
 * Deterministic SHA256 hash of a raw API key.
 *
 * WHY SHA256 here (and bcrypt for passwords elsewhere):
 * API keys need a DETERMINISTIC hash so the auth middleware can re-hash an
 * inbound raw key and use the digest as a Redis cache key (`tenant:{hash}`)
 * for cache-aside lookup. bcrypt is salted and non-deterministic — hashing
 * the same raw key twice yields two different outputs — so it CANNOT serve as
 * a lookup key and is the wrong tool for machine credentials.
 *
 * SHA256 is safe for API keys specifically because they are high-entropy
 * (128 bits of randomness from `crypto.randomBytes(16)`), making offline
 * brute-force infeasible regardless of hash cost — unlike human passwords,
 * which may be low-entropy and therefore require bcrypt's deliberate slowness
 * as a brute-force brake. This is the same pattern Stripe and AWS use for
 * their API keys. Password hashing stays on bcrypt; do not change that.
 */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a fresh API key tuple: raw key, display prefix, and SHA256 hash.
 */
export function generateApiKey(): GeneratedApiKey {
  const randomHex = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const rawKey = `${KEY_PREFIX_LITERAL}${randomHex}`;
  const prefix = rawKey.slice(0, 12);
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}
