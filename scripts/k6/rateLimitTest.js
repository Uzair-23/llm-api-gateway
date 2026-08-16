import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * Phase 10 — Concurrent Rate Limit Atomicity Test
 *
 * Architecture & Test Design:
 * - Uses ONLY main tenants[0] to isolate single-tenant sliding-window rate limit logic.
 * - Targets http://localhost:8080/v1/health/protected (auth + rate limiter only).
 * - Fires 200 concurrent requests in a single sharp burst (200 VUs, shared-iterations: 200).
 * - Verifies that atomic Lua script enforcement in Redis allows EXACTLY 100 requests through
 *   and rate-limits (429) the remaining 100 requests across 3 Dockerized gateway instances.
 */

const rawTenants = open('../seed/tenants.json');

const passedCount = new Counter('rate_limit_passed_200');
const limitedCount = new Counter('rate_limit_rejected_429');

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: 200,
      iterations: 200,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Zero 5xx/network failures allowed — requests must be either 200 or 429
    'http_req_failed{status:!429}': ['rate<0.01'],
  },
};

const BASE_URL = 'http://localhost:8080';
const EXPECTED_LIMIT = 100;

export function setup() {
  const parsed = JSON.parse(rawTenants);
  const tenants = parsed.tenants || (Array.isArray(parsed) ? parsed : []);

  if (!tenants || tenants.length === 0) {
    throw new Error('No tenants found in scripts/seed/tenants.json — run `node scripts/seed/seedTenants.js` first!');
  }
  return { tenant: tenants[0] };
}

export default function (data) {
  const { tenant } = data;

  const res = http.get(`${BASE_URL}/v1/health/protected`, {
    headers: {
      'Authorization': `Bearer ${tenant.apiKey}`,
    },
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });

  if (res.status === 200) {
    passedCount.add(1);
  } else if (res.status === 429) {
    limitedCount.add(1);
  }
}

export function handleSummary(data) {
  const total = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const passed = data.metrics.rate_limit_passed_200 ? data.metrics.rate_limit_passed_200.values.count : 0;
  const limited = data.metrics.rate_limit_rejected_429 ? data.metrics.rate_limit_rejected_429.values.count : 0;
  const errors = total - (passed + limited);

  const duration = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : {};
  const p50 = duration['med'] !== undefined ? duration['med'].toFixed(2) : 'N/A';
  const p95 = duration['p(95)'] !== undefined ? duration['p(95)'].toFixed(2) : 'N/A';
  const p99 = duration['p(99)'] !== undefined ? duration['p(99)'].toFixed(2) : 'N/A';

  const isPassed = passed === EXPECTED_LIMIT && limited === (total - EXPECTED_LIMIT) && errors === 0;

  const resultStatus = isPassed
    ? `✅ PASS: Exactly ${EXPECTED_LIMIT} requests passed (200), ${limited} were rate-limited (429).`
    : `❌ FAIL: ${passed} passed (expected ${EXPECTED_LIMIT}). Check for race conditions or state pollution.`;

  const summaryText = `
================================================================================
⚡ PHASE 10: CONCURRENT RATE LIMIT ATOMICITY TEST SUMMARY (200 Burst VUs)
================================================================================
Target URL:              ${BASE_URL}/v1/health/protected
Total Requests Fired:    ${total}
Expected Pass Limit:     ${EXPECTED_LIMIT}
--------------------------------------------------------------------------------
Result Breakdown:
  - ✅ 200 Passed:        ${passed}
  - ❌ 429 Limited:       ${limited}
  - 💥 Server Errors:     ${errors}
--------------------------------------------------------------------------------
Request Latency (ms):
  - p50:                 ${p50} ms
  - p95:                 ${p95} ms
  - p99:                 ${p99} ms
--------------------------------------------------------------------------------
VERDICT:                 ${resultStatus}
================================================================================
`;

  return {
    stdout: summaryText,
  };
}
