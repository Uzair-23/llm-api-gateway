/**
 * Centralized Redis key-name generators.
 *
 * Per the conventions doc: never string-template Redis keys inline in
 * multiple files — route every key through this module so a format change
 * is a single-edit operation and can't silently cause cache-key mismatches.
 */

/**
 * Cache-aside key for tenant lookups by API key hash.
 * TTL: 5 minutes (300s) per the PRD request flow.
 */
export function tenantByApiKeyHashKey(apiKeyHash: string): string {
  return `tenant:${apiKeyHash}`;
}

/**
 * Rate-limit sorted-set key for a tenant.
 * Used by the sliding-window Lua script.
 */
export function rateLimitKey(tenantId: string): string {
  return `ratelimit:${tenantId}`;
}
