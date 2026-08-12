import { createHash } from 'crypto';

/**
 * Compute the cache key hash for a { prompt, model } pair.
 *
 * Uses SHA256 of JSON.stringify({ prompt, model }) — the hash is deterministic
 * so the same prompt+model always produces the same cache key.
 *
 * WHY fixed field order matters:
 * JSON.stringify preserves insertion order of object keys. If we built the
 * object from an arbitrary source (e.g. spread of req.body), the key order
 * could vary between calls, producing different hashes for semantically
 * identical requests. By constructing the object literal with `prompt` first
 * and `model` second in a fixed order, we guarantee the same JSON string —
 * and therefore the same hash — every time.
 *
 * The cache is intentionally SHARED across tenants: the LLM response for
 * "same prompt, same model" is deterministic content, not tenant-specific
 * data. Two different tenants sending the identical prompt+model SHOULD hit
 * the same cache entry.
 */
export function hashPrompt(prompt: string, model: string): string {
  // Fixed key order: prompt first, model second. Never spread from an
  // arbitrary object — always construct the literal explicitly.
  const json = JSON.stringify({ prompt, model });
  return createHash('sha256').update(json).digest('hex');
}
