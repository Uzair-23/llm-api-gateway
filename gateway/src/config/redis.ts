import Redis from 'ioredis';
import { env } from './env';

/**
 * Redis client singleton.
 *
 * All shared state (rate-limit counters, cache, circuit-breaker flags, tenant
 * cache-aside lookups) lives in this single Redis instance — never in gateway
 * process memory. This is what makes horizontal scaling correct across N
 * gateway instances behind Nginx.
 *
 * In tests we don't connect to a real Redis by default; the auth middleware
 * is designed to degrade gracefully (see auth.middleware.ts) so tests can run
 * without a Redis server. When a real Redis is available (e.g. via
 * docker-compose), this singleton connects lazily on first use.
 */
let redisClient: Redis | null = null;

/**
 * Get the shared Redis client, creating it on first call (lazy singleton).
 * Lazy creation lets tests import the app without forcing a Redis connection.
 */
export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      // Don't crash the process on connection errors — the auth middleware
      // handles a missing/unreachable Redis by falling back to MongoDB.
      retryStrategy: (times) => Math.min(times * 200, 2000),
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => {
      // Log but don't throw — Redis being down should not kill the gateway.
      console.error('Redis client error:', err.message);
    });
    // Log on successful connection so startup is visually confirmable, the
    // same way the Mongo connection is. ioredis connects asynchronously; this
    // 'ready' event fires on its own once the TCP handshake + AUTH complete.
    redisClient.on('ready', () => {
      console.log('✅ Redis connected');
    });
  }
  return redisClient;
}

/**
 * Whether the Redis client has been instantiated. Used by the auth middleware
 * to decide whether to attempt a cache lookup or skip straight to MongoDB.
 */
export function isRedisAvailable(): boolean {
  return redisClient !== null && redisClient.status === 'ready';
}

/**
 * Close the Redis connection (used in tests / graceful shutdown).
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

export default getRedis;
