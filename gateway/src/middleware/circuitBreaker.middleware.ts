import { Request, Response, NextFunction } from 'express';
import { isRedisAvailable } from '../config/redis';
import {
  CircuitBreakerConfig,
  DEFAULT_CIRCUIT_CONFIG,
  runCircuitAction,
} from '../utils/reportCircuitResult.util';

/**
 * Redis-backed circuit-breaker middleware.
 *
 * Executes an atomic CHECK action through Lua before upstream calls.
 * - ALLOW: request may continue to upstream route handler.
 * - DENY: respond 503 immediately (short-circuit).
 *
 * Failure mode: FAIL OPEN.
 * If Redis is unavailable or script execution fails, allow traffic through and
 * log [CIRCUIT-DEGRADED] so availability wins over strict protection.
 */
export function circuitBreaker(
  provider: string,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isRedisAvailable()) {
      console.error('[CIRCUIT-DEGRADED] Redis unavailable — allowing request through (fail-open)');
      res.locals.circuitProvider = provider;
      next();
      return;
    }

    try {
      const decision = await runCircuitAction(provider, 'CHECK', config);

      if (decision === 'ALLOW') {
        res.locals.circuitProvider = provider;
        next();
        return;
      }

      res.status(503).json({
        error: 'Service temporarily unavailable',
        provider,
        state: 'open',
      });
    } catch (err) {
      console.error(
        '[CIRCUIT-DEGRADED] Redis error during circuit check — allowing request through (fail-open):',
        err instanceof Error ? err.message : err,
      );
      res.locals.circuitProvider = provider;
      next();
    }
  };
}
