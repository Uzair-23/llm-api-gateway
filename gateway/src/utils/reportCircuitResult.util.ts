import { readFileSync } from 'fs';
import { join } from 'path';
import { getRedis } from '../config/redis';
import { circuitStateKey, circuitFailuresKey, circuitUpstreamCallsKey } from './keys';

export type CircuitAction = 'CHECK' | 'REPORT_SUCCESS' | 'REPORT_FAILURE';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  failureWindowMs: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  cooldownMs: 60_000,
};

const luaScriptPath = join(__dirname, '..', 'lua', 'circuitBreaker.lua');
const luaScript = readFileSync(luaScriptPath, 'utf-8');
let circuitScriptSha: string | null = null;

/**
 * Execute the circuit-breaker Lua script atomically.
 *
 * Uses EVALSHA fast-path with NOSCRIPT fallback to EVAL, then caches SHA.
 */
export async function runCircuitAction(
  provider: string,
  action: CircuitAction,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
  nowMs = Date.now(),
): Promise<string> {
  const redis = getRedis();
  const stateKey = circuitStateKey(provider);
  const failuresKey = circuitFailuresKey(provider);

  if (circuitScriptSha) {
    try {
      const result = await redis.evalsha(
        circuitScriptSha,
        2,
        stateKey,
        failuresKey,
        String(nowMs),
        action,
        String(config.failureThreshold),
        String(config.failureWindowMs),
        String(config.cooldownMs),
      );
      return String(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('NOSCRIPT')) {
        throw err;
      }
    }
  }

  const result = await redis.eval(
    luaScript,
    2,
    stateKey,
    failuresKey,
    String(nowMs),
    action,
    String(config.failureThreshold),
    String(config.failureWindowMs),
    String(config.cooldownMs),
  );

  circuitScriptSha = (await redis.script('LOAD', luaScript)) as string;
  return String(result);
}

export async function reportCircuitSuccess(
  provider: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<void> {
  await runCircuitAction(provider, 'REPORT_SUCCESS', config);
}

export async function reportCircuitFailure(
  provider: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
): Promise<void> {
  await runCircuitAction(provider, 'REPORT_FAILURE', config);
}

/**
 * Admin helper: force-reset a provider circuit to CLOSED and clear counters.
 */
export async function resetCircuit(provider: string): Promise<void> {
  const redis = getRedis();
  const stateKey = circuitStateKey(provider);
  const failuresKey = circuitFailuresKey(provider);
  const upstreamCallsKey = circuitUpstreamCallsKey(provider);

  await redis
    .multi()
    .hset(stateKey, 'state', 'closed', 'consecutiveSuccesses', '0', 'openedAt', '0', 'trialInFlight', '0')
    .del(failuresKey)
    .del(upstreamCallsKey)
    .exec();
}
