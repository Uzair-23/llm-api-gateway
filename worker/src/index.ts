/**
 * NOTE (Portfolio Architecture Simplification):
 * The worker is a separate process/directory from gateway/, per monorepo structure.
 * Rather than duplicating upstream services, circuit breaker logic, or cache utilities
 * (or extracting a published npm package for this portfolio project), the worker
 * directly imports these modules from `gateway/src/` via relative paths.
 * In a production multi-package system, this shared logic would be extracted into a
 * dedicated shared internal package (e.g. @gateway/core).
 */

import { Worker } from 'bullmq';
import { connectionOptions } from '../../gateway/src/config/queue';
import { processChatJob, ChatJobData } from './processors/chatJob.processor';

const CONCURRENCY = 5;

export const worker = new Worker<ChatJobData>('llm-jobs', processChatJob, {
  connection: connectionOptions,
  concurrency: CONCURRENCY,
});

worker.on('ready', () => {
  console.log(`⚡ Worker ready for queue 'llm-jobs' (concurrency: ${CONCURRENCY})`);
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('Worker error:', err.message);
});

export default worker;
