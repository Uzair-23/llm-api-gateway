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

/**
 * Response cache key for a given prompt+model hash.
 * TTL: 3600 seconds (1 hour) per PRD.md Section 7.
 */
export function cacheKey(hash: string): string {
  return `cache:${hash}`;
}

/**
 * Circuit-breaker state hash key per upstream provider.
 * Provider-scoped (not tenant-scoped): this protects upstream health.
 */
export function circuitStateKey(provider: string): string {
  return `circuit:${provider}`;
}

/**
 * Circuit-breaker failure-window sorted-set key per provider.
 */
export function circuitFailuresKey(provider: string): string {
  return `circuit:${provider}:failures`;
}

/**
 * Temporary key for counting simulated upstream invocations per provider.
 * Used only by Phase 5 test route/admin visibility.
 */
export function circuitUpstreamCallsKey(provider: string): string {
  return `circuit:${provider}:upstream-calls`;
}
