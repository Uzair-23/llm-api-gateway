import { Queue, ConnectionOptions } from 'bullmq';
import { env } from './env';

/**
 * Helper to parse a Redis connection URL into ioredis ConnectionOptions for BullMQ.
 * BullMQ requires its own connection options object (or dedicated ioredis instance
 * with `maxRetriesPerRequest: null`).
 */
export function parseRedisUrl(redisUrl: string): ConnectionOptions {
  try {
    const urlStr = redisUrl.includes('://') ? redisUrl : `redis://${redisUrl}`;
    const parsed = new URL(urlStr);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) : undefined,
      maxRetriesPerRequest: null,
    };
  } catch (_err) {
    return {
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
}

export const connectionOptions: ConnectionOptions = parseRedisUrl(env.REDIS_URL);

let queueInstance: Queue | null = null;

/**
 * Get or initialize the singleton BullMQ Queue instance named 'llm-jobs'.
 */
export function getQueue(): Queue {
  if (!queueInstance) {
    queueInstance = new Queue('llm-jobs', {
      connection: connectionOptions,
    });
  }
  return queueInstance;
}

/**
 * Close the BullMQ Queue connection (used during test teardown and graceful shutdown).
 */
export async function closeQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}
