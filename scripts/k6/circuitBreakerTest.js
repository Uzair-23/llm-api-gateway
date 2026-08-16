import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

/**
 * Phase 10 — Circuit Breaker Failover Verification
 *
 * Architecture & Test Design:
 * - Uses main tenants[1] to isolate from other test tenants.
 * - Step 1 (Trip Phase): Sends 10 requests with an invalid model ("definitely-not-a-real-model").
 *   Uses LATENCY as the key signal to distinguish real upstream round-trip failures (>50ms)
 *   from immediate short-circuits (<=50ms with status 503) once the threshold (5 failures) is tripped.
 * - Step 2 (Verify Phase): Sends 5 follow-up requests and asserts that they immediately return
 *   503 Service Unavailable in < 100ms without attempting upstream network calls.
 *
 * NOTE: Circuit state is stored in centralized Redis (`circuit:groq`). After running
 * this script, reset the circuit state via:
 *   curl -X POST http://localhost:8080/admin/circuit/reset -H "Content-Type: application/json" -d '{"provider":"groq"}'
 */

const rawTenants = open('../seed/tenants.json');

const realUpstreamFailuresCount = new Counter('circuit_real_upstream_failures');
const earlyShortCircuitCount = new Counter('circuit_early_short_circuits');
const step2ShortCircuitCount = new Counter('circuit_step2_short_circuits_503');
const shortCircuitDuration = new Trend('circuit_short_circuit_duration', true);

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  vus: 1,
  iterations: 1,
};

const BASE_URL = 'http://localhost:8080';
const INVALID_MODEL = 'definitely-not-a-real-model';
const VALID_MODEL = 'llama-3.1-8b-instant';

export function setup() {
  const parsed = JSON.parse(rawTenants);
  const tenants = parsed.tenants || (Array.isArray(parsed) ? parsed : []);

  if (!tenants || tenants.length < 2) {
    throw new Error('Need at least 2 main tenants in scripts/seed/tenants.json — run `node scripts/seed/seedTenants.js` first!');
  }
  return { tenant: tenants[1] };
}

export default function (data) {
  const { tenant } = data;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tenant.apiKey}`,
  };

  console.log('⚡ [STEP 1] Sending 10 invalid requests to trip the circuit breaker...');
  for (let i = 1; i <= 10; i += 1) {
    const res = http.post(
      `${BASE_URL}/v1/chat/completions`,
      JSON.stringify({ prompt: `Tripping circuit attempt ${i}`, model: INVALID_MODEL }),
      { headers, timeout: '10s' }
    );

    // FIX 4: Use LATENCY (>50ms) to identify real upstream round-trip failures vs early short circuits (<=50ms)
    if (res.timings.duration > 50) {
      realUpstreamFailuresCount.add(1);
      console.log(`   Attempt ${i}/10: Real upstream failure (status=${res.status}, duration=${res.timings.duration.toFixed(1)}ms)`);
    } else if (res.status === 503 && res.timings.duration <= 50) {
      earlyShortCircuitCount.add(1);
      console.log(`   Attempt ${i}/10: Short-circuited (status=${res.status}, duration=${res.timings.duration.toFixed(1)}ms)`);
    } else {
      console.log(`   Attempt ${i}/10: Response (status=${res.status}, duration=${res.timings.duration.toFixed(1)}ms)`);
    }
    sleep(0.1);
  }

  console.log('⚡ [STEP 2] Verifying short-circuit failover on 5 subsequent requests...');
  for (let i = 1; i <= 5; i += 1) {
    const res = http.post(
      `${BASE_URL}/v1/chat/completions`,
      JSON.stringify({ prompt: `Short circuit check ${i}`, model: VALID_MODEL }),
      { headers, timeout: '5s' }
    );

    const is503 = res.status === 503;
    const isFast = res.timings.duration < 100;

    check(res, {
      'status is 503 (circuit open)': (r) => r.status === 503,
      'fast response (<100ms short circuit)': (r) => r.timings.duration < 100,
    });

    if (is503 && isFast) {
      step2ShortCircuitCount.add(1);
      shortCircuitDuration.add(res.timings.duration);
    }
    console.log(`   Check ${i}/5: status=${res.status}, duration=${res.timings.duration.toFixed(1)}ms`);
    sleep(0.1);
  }
}

export function handleSummary(data) {
  const realFailures = data.metrics.circuit_real_upstream_failures ? data.metrics.circuit_real_upstream_failures.values.count : 0;
  const earlyShortCircuits = data.metrics.circuit_early_short_circuits ? data.metrics.circuit_early_short_circuits.values.count : 0;
  const step2ShortCircuits = data.metrics.circuit_step2_short_circuits_503 ? data.metrics.circuit_step2_short_circuits_503.values.count : 0;

  const duration = data.metrics.circuit_short_circuit_duration ? data.metrics.circuit_short_circuit_duration.values : {};
  const p50 = duration['med'] !== undefined ? duration['med'].toFixed(2) : 'N/A';
  const p95 = duration['p(95)'] !== undefined ? duration['p(95)'].toFixed(2) : 'N/A';
  const p99 = duration['p(99)'] !== undefined ? duration['p(99)'].toFixed(2) : 'N/A';

  const isSuccess = (realFailures + earlyShortCircuits) >= 5 && step2ShortCircuits >= 5;

  const summaryText = `
================================================================================
🔌 PHASE 10: CIRCUIT BREAKER FAILOVER TEST SUMMARY
================================================================================
Target URL:              ${BASE_URL}/v1/chat/completions
--------------------------------------------------------------------------------
Trip Phase Breakdown (Step 1):
  - Real Upstream Failures (>50ms):  ${realFailures}
  - Early Short-Circuits (<=50ms):   ${earlyShortCircuits}
  - Total Trip Signals:               ${realFailures + earlyShortCircuits} (Threshold: >=5)
--------------------------------------------------------------------------------
Verification Phase (Step 2):
  - Short-Circuited Requests (503):   ${step2ShortCircuits}/5
  - Short-Circuit Latency:            p50 = ${p50} ms | p95 = ${p95} ms | p99 = ${p99} ms
--------------------------------------------------------------------------------
VERDICT:                 ${isSuccess ? '✅ PASS: Circuit tripped to OPEN (5 failures observed) and correctly short-circuited all subsequent requests in <100ms.' : '❌ FAIL: Circuit did not trip or failed to short-circuit in <100ms.'}
================================================================================
⚠️  REMINDER: Reset the circuit breaker state in Redis before further tests:
    curl -X POST http://localhost:8080/admin/circuit/reset \\
      -H "Content-Type: application/json" \\
      -d '{"provider":"groq"}'
================================================================================
`;

  return {
    stdout: summaryText,
  };
}
