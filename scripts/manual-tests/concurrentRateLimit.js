#!/usr/bin/env node
/**
 * Manual concurrency verification for the sliding-window rate limiter.
 *
 * Fires 200 concurrent requests against the protected route and prints how
 * many passed (200) vs were rate-limited (429). This proves the Lua script's
 * atomicity under real concurrent load — matching PRD.md Phase 3's requirement
 * to "write a small script that fires 200 concurrent requests against a limit
 * of 100/min — confirm exactly 100 pass."
 *
 * Usage:
 *   1. Start the gateway: `npm run dev` (or via docker-compose on :8080)
 *   2. Sign up a tenant and get an API key (or use an existing one)
 *   3. Run: `node scripts/manual-tests/concurrentRateLimit.js <API_KEY> [BASE_URL] [EXPECTED_LIMIT]`
 *
 * Arguments:
 *   API_KEY        — a valid sk-live-... API key for an existing tenant
 *   BASE_URL       — (optional) gateway/Nginx URL (default: http://localhost:4000)
 *   EXPECTED_LIMIT — (optional) how many requests should pass (default: 100)
 *
 * Example (Direct gateway — localhost:4000):
 *   node scripts/manual-tests/concurrentRateLimit.js sk-live-abc123...
 *
 * Example (Nginx reverse proxy — localhost:8080):
 *   node scripts/manual-tests/concurrentRateLimit.js sk-live-abc123... http://localhost:8080
 */

const API_KEY = process.argv[2];

let BASE_URL = 'http://localhost:4000';
let EXPECTED_LIMIT = 100;

for (let i = 3; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    BASE_URL = arg.replace(/\/+$/, '');
  } else if (!isNaN(parseInt(arg, 10))) {
    EXPECTED_LIMIT = parseInt(arg, 10);
  }
}

const ENDPOINT = '/v1/health/protected';
const CONCURRENCY = 200;

if (!API_KEY) {
  console.error('Usage: node scripts/manual-tests/concurrentRateLimit.js <API_KEY> [BASE_URL] [EXPECTED_LIMIT]');
  console.error('  API_KEY        — a valid sk-live-... API key');
  console.error('  BASE_URL       — target base URL (default: http://localhost:4000)');
  console.error('  EXPECTED_LIMIT — how many requests should pass (default: 100)');
  process.exit(1);
}

async function fireRequest(i) {
  try {
    const res = await fetch(`${BASE_URL}${ENDPOINT}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
    });
    return { index: i, status: res.status };
  } catch (err) {
    return { index: i, status: 'error', error: err.message };
  }
}

async function main() {
  console.log(`Firing ${CONCURRENCY} concurrent requests against ${BASE_URL}${ENDPOINT}...`);
  console.log(`Expected limit: ${EXPECTED_LIMIT} requests per window`);
  console.log('');

  const start = Date.now();
  const promises = Array.from({ length: CONCURRENCY }, (_, i) => fireRequest(i));
  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;

  const passed = results.filter(r => r.status === 200).length;
  const limited = results.filter(r => r.status === 429).length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log(`Completed in ${elapsed}ms`);
  console.log(`✅ 200 OK:      ${passed}`);
  console.log(`❌ 429 Limited:  ${limited}`);
  console.log(`💥 Errors:      ${errors}`);
  console.log('');

  if (errors > 0) {
    console.log(`💥 FAIL: Some requests errored (is the gateway running on ${BASE_URL}?)`);
    process.exit(1);
  }

  if (passed === EXPECTED_LIMIT && limited === CONCURRENCY - EXPECTED_LIMIT) {
    console.log(`✅ PASS: Exactly ${EXPECTED_LIMIT} requests passed, ${CONCURRENCY - EXPECTED_LIMIT} were rate-limited.`);
    console.log('   The sliding-window Lua script is atomic under concurrency.');
  } else if (passed > EXPECTED_LIMIT) {
    console.log(`❌ FAIL: ${passed} requests passed (expected ${EXPECTED_LIMIT}) — race condition detected!`);
    console.log('   The check-and-increment is NOT atomic.');
    process.exit(1);
  } else {
    console.log(`⚠️  UNEXPECTED: ${passed} passed (expected ${EXPECTED_LIMIT}).`);
    console.log('   Check if the limit is configured correctly on the route,');
    console.log('   or if a previous run left entries in the rate-limit window.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});