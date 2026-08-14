#!/usr/bin/env node
/**
 * Manual verification script for the async queue path & worker process.
 *
 * Fires 50 concurrent async requests to POST /v1/chat/completions?async=true,
 * collects the jobIds returned (202 Accepted), and polls GET /v1/jobs/:jobId
 * every 500ms until all jobs complete, fail, or time out.
 *
 * Usage:
 *   1. Start the gateway on :4000 (`cd gateway && npm run dev`)
 *   2. Start the worker (`cd worker && npm run dev`)
 *   3. Sign up a tenant and get an API key
 *   4. Run: `node scripts/manual-tests/asyncJobBurst.js <API_KEY>`
 *
 * Arguments:
 *   API_KEY — a valid sk-live-... API key for an existing tenant
 */

const API_KEY = process.argv[2];
const BASE_URL = 'http://localhost:4000';
const POST_ENDPOINT = '/v1/chat/completions?async=true';
const CONCURRENCY = 50;
const POLL_INTERVAL_MS = 500;
const MAX_TIMEOUT_MS = 30000;

if (!API_KEY) {
  console.error('Usage: node scripts/manual-tests/asyncJobBurst.js <API_KEY>');
  console.error('  API_KEY — a valid sk-live-... API key');
  process.exit(1);
}

async function submitJob(i) {
  try {
    const res = await fetch(`${BASE_URL}${POST_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: `Test prompt number ${i} - timestamp ${Date.now()}`,
        model: 'llama-3.1-8b-instant',
      }),
    });

    const data = await res.json();
    if (res.status === 202 && data.jobId) {
      return { index: i, success: true, jobId: String(data.jobId), status: res.status };
    }
    return { index: i, success: false, status: res.status, error: data.error || JSON.stringify(data) };
  } catch (err) {
    return { index: i, success: false, status: 'error', error: err.message };
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
    });

    const data = await res.json();
    if (res.status === 200) {
      return { status: data.status, result: data.result, error: data.error };
    }
    return { status: 'error', error: data.error || `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

async function main() {
  console.log(`🚀 Submitting ${CONCURRENCY} concurrent async jobs to ${BASE_URL}${POST_ENDPOINT}...`);
  const startTime = Date.now();

  // Phase 1: Submit 50 jobs concurrently
  const submitPromises = Array.from({ length: CONCURRENCY }, (_, i) => submitJob(i + 1));
  const submitResults = await Promise.all(submitPromises);
  const enqueueTime = Date.now() - startTime;

  const enqueuedJobs = submitResults.filter((r) => r.success && r.jobId);
  const submitFailures = submitResults.filter((r) => !r.success);

  console.log(`📤 Enqueued ${enqueuedJobs.length}/${CONCURRENCY} jobs in ${enqueueTime}ms (Failures: ${submitFailures.length})`);

  if (submitFailures.length > 0) {
    console.error('⚠️ Some submission requests failed:');
    submitFailures.slice(0, 5).forEach((f) => console.error(`   Job ${f.index}: Status ${f.status} - ${f.error}`));
  }

  if (enqueuedJobs.length === 0) {
    console.error('💥 FAIL: No jobs were enqueued successfully. Exiting.');
    process.exit(1);
  }

  // Phase 2: Track and poll job states
  const jobMap = new Map();
  enqueuedJobs.forEach((j) => {
    jobMap.set(j.jobId, { status: 'waiting', result: null, error: null });
  });

  console.log(`🔄 Polling ${jobMap.size} enqueued jobs every ${POLL_INTERVAL_MS}ms (Timeout: ${MAX_TIMEOUT_MS / 1000}s)...`);

  const pollStartTime = Date.now();
  let remainingJobIds = Array.from(jobMap.keys());

  while (remainingJobIds.length > 0 && Date.now() - pollStartTime < MAX_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const pollPromises = remainingJobIds.map(async (jobId) => {
      const pollRes = await pollJob(jobId);
      return { jobId, ...pollRes };
    });

    const pollResults = await Promise.all(pollPromises);

    pollResults.forEach((res) => {
      const existing = jobMap.get(res.jobId);
      if (res.status === 'completed' || res.status === 'failed') {
        jobMap.set(res.jobId, { status: res.status, result: res.result, error: res.error });
      } else if (res.status === 'error') {
        jobMap.set(res.jobId, { status: 'error', error: res.error });
      } else if (existing) {
        jobMap.set(res.jobId, { ...existing, status: res.status });
      }
    });

    remainingJobIds = Array.from(jobMap.entries())
      .filter(([_, info]) => info.status === 'waiting' || info.status === 'active')
      .map(([id]) => id);

    const completedCount = Array.from(jobMap.values()).filter((v) => v.status === 'completed').length;
    const failedCount = Array.from(jobMap.values()).filter((v) => v.status === 'failed').length;
    const pendingCount = remainingJobIds.length;

    console.log(`   [+${((Date.now() - pollStartTime) / 1000).toFixed(1)}s] Progress: ${completedCount} completed, ${failedCount} failed, ${pendingCount} in flight`);
  }

  const totalTime = Date.now() - startTime;
  const finalResults = Array.from(jobMap.values());
  const completed = finalResults.filter((r) => r.status === 'completed').length;
  const failed = finalResults.filter((r) => r.status === 'failed').length;
  const timedOut = finalResults.filter((r) => r.status === 'waiting' || r.status === 'active').length;

  console.log('\n=================== SUMMARY ===================');
  console.log(`⏱️ Total Time Elapsed: ${totalTime}ms`);
  console.log(`📥 Total Jobs Sent:    ${CONCURRENCY}`);
  console.log(`✅ Completed:          ${completed}`);
  console.log(`❌ Failed:             ${failed}`);
  console.log(`⏳ Timed Out/In-Flight: ${timedOut}`);
  console.log('===============================================\n');

  if (completed === CONCURRENCY) {
    console.log('🎉 SUCCESS: All 50 async jobs processed to completion!');
  } else if (completed + failed === enqueuedJobs.length) {
    console.log(`✅ SUCCESS: All ${enqueuedJobs.length} enqueued jobs finished processing (${completed} completed, ${failed} failed).`);
  } else {
    console.log('⚠️ PARTIAL / FAIL: Some jobs did not finish within timeout period.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
