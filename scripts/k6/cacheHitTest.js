import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

/**
 * Phase 10 — Main 500-VU Cache Hit Capacity Test
 *
 * Architecture & Test Design:
 * - Shared cache is keyed by SHA256({prompt, model}) across ALL tenants in Redis.
 * - setup() uses a dedicated warm-up tenant (isolated from rateLimitTest's tenant)
 *   to warm 25 distinct prompts once via real upstream calls.
 * - 500 VUs then hit these exact 25 prompts spread across 250 seeded main tenants.
 * - Confirms that under 500 concurrent VUs, cache hits achieve p99 < 300ms latency.
 */

const rawTenants = open('../seed/tenants.json');

const cacheHitDuration = new Trend('cache_hit_duration', true);
const rateLimitedCount = new Counter('rate_limited_during_cache_test');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  stages: [
    { duration: '20s', target: 500 }, // Ramp 0 -> 500 VUs over 20s
    { duration: '20s', target: 500 }, // Hold 500 VUs for 20s
    { duration: '10s', target: 0 },   // Ramp down to 0 VUs over 10s
  ],
  thresholds: {
    // PRD Non-Functional Requirement: p99 latency < 300ms for cache hits
    cache_hit_duration: ['p(99)<300'],
    // Hard failures (5xx/network errors) must be under 1%. 429s are rate-limiting, not server crashes.
    'http_req_failed{status:!429}': ['rate<0.01'],
  },
};

const BASE_URL = 'http://localhost:8080';
const MODEL = 'llama-3.1-8b-instant';

export function setup() {
  const parsed = JSON.parse(rawTenants);

  // Support both object schema { warmupTenants, tenants } and legacy array fallback
  const warmupTenants = parsed.warmupTenants || (Array.isArray(parsed) ? parsed : []);
  const tenants = parsed.tenants || (Array.isArray(parsed) ? parsed : []);

  if (!tenants || tenants.length === 0) {
    throw new Error('No tenants found in scripts/seed/tenants.json — run `node scripts/seed/seedTenants.js` first!');
  }

  // Use dedicated warm-up tenant to avoid rate-limit state pollution from rateLimitTest.js
  const warmupApiKey = warmupTenants.length > 0 ? warmupTenants[0].apiKey : tenants[0].apiKey;
  const prompts = Array.from({ length: 25 }, (_, i) => `Load test prompt number ${i + 1}`);

  console.log(`🔥 [SETUP] Warming shared Redis cache with ${prompts.length} distinct prompts using dedicated warm-up tenant...`);

  prompts.forEach((prompt, idx) => {
    const res = http.post(
      `${BASE_URL}/v1/chat/completions`,
      JSON.stringify({ prompt, model: MODEL }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${warmupApiKey}`,
        },
        timeout: '15s',
      },
    );

    console.log(
      `   Warm-up ${idx + 1}/25: status=${res.status}, latency=${res.timings.duration.toFixed(1)}ms`
    );
  });

  console.log(`✅ [SETUP] Cache warm-up complete! Starting 500-VU capacity test across ${tenants.length} main tenants...`);

  return { tenants, prompts };
}

export default function (data) {
  const { tenants, prompts } = data;

  // Pick a random prompt from the 25 warmed prompts (guarantees cache hit)
  const prompt = prompts[Math.floor(Math.random() * prompts.length)];

  // Random selection across 250 main tenants to distribute rate limits
  const tenant = tenants[Math.floor(Math.random() * tenants.length)];

  const res = http.post(
    `${BASE_URL}/v1/chat/completions`,
    JSON.stringify({ prompt, model: MODEL }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tenant.apiKey}`,
      },
    },
  );

  let isCacheHit = false;

  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      isCacheHit = body.cacheHit === true;
    } catch (_e) {
      isCacheHit = false;
    }
  }

  // k6 check assertions
  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'response is cache hit when 200': (_r) => res.status !== 200 || isCacheHit,
  });

  if (res.status === 200 && isCacheHit) {
    cacheHitDuration.add(res.timings.duration);
  } else if (res.status === 429) {
    rateLimitedCount.add(1);
  }

  // Small sleep (0.3s - 0.5s) per VU to avoid exhausting single-tenant rate limit too quickly
  sleep(0.3 + Math.random() * 0.2);
}

export function handleSummary(data) {
  const reqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const rps = data.metrics.http_reqs ? data.metrics.http_reqs.values.rate.toFixed(2) : 0;

  const hitDuration = data.metrics.cache_hit_duration ? data.metrics.cache_hit_duration.values : {};
  const p50 = hitDuration['med'] !== undefined ? hitDuration['med'].toFixed(2) : 'N/A';
  const p95 = hitDuration['p(95)'] !== undefined ? hitDuration['p(95)'].toFixed(2) : 'N/A';
  const p99 = hitDuration['p(99)'] !== undefined ? hitDuration['p(99)'].toFixed(2) : 'N/A';

  const rateLimited = data.metrics.rate_limited_during_cache_test
    ? data.metrics.rate_limited_during_cache_test.values.count
    : 0;

  const rateLimitPercent = reqs > 0 ? (rateLimited / reqs) * 100 : 0;
  const rateLimitStatus = rateLimitPercent > 30
    ? `⚠️ WARNING: High rate-limiting (${rateLimitPercent.toFixed(1)}% > 30%). Cache hit latency sample size may be degraded.`
    : `✅ PASS: Rate limit rejections were ${rateLimitPercent.toFixed(1)}% (under 30% threshold). Sample size is credible.`;

  const summaryText = `
================================================================================
📊 PHASE 10: CACHE HIT CAPACITY TEST SUMMARY (500 VUs)
================================================================================
Target URL:              ${BASE_URL}/v1/chat/completions
Total Requests:          ${reqs}
Throughput:              ${rps} req/sec
--------------------------------------------------------------------------------
Cache Hit Latency (ms):
  - p50 (median):        ${p50} ms
  - p95:                 ${p95} ms
  - p99 (Target <300ms): ${p99} ms
--------------------------------------------------------------------------------
Rate-Limited Requests:   ${rateLimited} (${rateLimitPercent.toFixed(1)}% of total requests)
Sample Size Evaluation:  ${rateLimitStatus}
================================================================================
`;

  return {
    stdout: summaryText,
  };
}
