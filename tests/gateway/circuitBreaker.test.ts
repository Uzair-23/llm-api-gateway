import request from 'supertest';
import express, { Express } from 'express';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { auth } from '../../gateway/src/middleware/auth.middleware';
import { rateLimiter } from '../../gateway/src/middleware/rateLimiter.middleware';
import { circuitBreaker } from '../../gateway/src/middleware/circuitBreaker.middleware';
import { getRedis, disconnectRedis } from '../../gateway/src/config/redis';
import {
  DEFAULT_CIRCUIT_CONFIG,
  reportCircuitFailure,
  reportCircuitSuccess,
} from '../../gateway/src/utils/reportCircuitResult.util';

let mongoServer: MongoMemoryServer;

const PROVIDER = 'test-provider';
const CIRCUIT_ROUTE = '/v1/test-circuit';
const STATUS_ROUTE = '/admin/circuit-status';
const RESET_ROUTE = '/admin/circuit/reset';

const TEST_CIRCUIT_CONFIG = {
  failureThreshold: 3,
  failureWindowMs: 2_000,
  cooldownMs: 3_000,
};

// Test-specific config comes from gateway/src/index.ts when NODE_ENV=test.
const TEST_FAILURE_THRESHOLD = 3;
const TEST_COOLDOWN_MS = 3_000;

function buildTestCircuitApp(): Express {
  const testApp = express();
  testApp.use(express.json());
  testApp.post(
    CIRCUIT_ROUTE,
    auth,
    rateLimiter(100, 60),
    circuitBreaker(PROVIDER, TEST_CIRCUIT_CONFIG),
    async (req, res) => {
      const forceFailure = Boolean(req.body?.forceFailure);
      const simulatedDelayMs = Number(req.body?.simulatedDelayMs ?? 0);

      try {
        await getRedis().incr(`circuit:${PROVIDER}:upstream-calls`);
      } catch (err) {
        console.error(
          '[CIRCUIT-DEGRADED] Failed to increment simulated upstream counter:',
          err instanceof Error ? err.message : err,
        );
      }

      if (forceFailure) {
        if (simulatedDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));
        }

        try {
          await reportCircuitFailure(PROVIDER, TEST_CIRCUIT_CONFIG);
        } catch (err) {
          console.error(
            '[CIRCUIT-DEGRADED] Failed to report simulated upstream failure:',
            err instanceof Error ? err.message : err,
          );
        }

        res.status(502).json({ error: 'Simulated upstream failure', provider: PROVIDER });
        return;
      }

      if (simulatedDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));
      }

      try {
        await reportCircuitSuccess(PROVIDER, TEST_CIRCUIT_CONFIG);
      } catch (err) {
        console.error(
          '[CIRCUIT-DEGRADED] Failed to report simulated upstream success:',
          err instanceof Error ? err.message : err,
        );
      }

      res.status(200).json({ response: 'Simulated success', provider: PROVIDER });
    },
  );

  return testApp;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const redis = getRedis();
  await redis.ping();
  expect(redis.status).toBe('ready');
});

beforeEach(async () => {
  await mongoose.connection.db?.dropDatabase();

  const redis = getRedis();
  const keys = await redis.keys('circuit:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  const tenantKeys = await redis.keys('tenant:*');
  if (tenantKeys.length > 0) {
    await redis.del(...tenantKeys);
  }

  const rateLimitKeys = await redis.keys('ratelimit:*');
  if (rateLimitKeys.length > 0) {
    await redis.del(...rateLimitKeys);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  await disconnectRedis();
});

function uniqueEmail(): string {
  return `circuit-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupTenant() {
  const res = await request(app)
    .post('/auth/signup')
    .send({ email: uniqueEmail(), password: 'password123' });

  expect(res.status).toBe(201);
  return res.body.apiKey as string;
}

async function callTestCircuit(apiKey: string, forceFailure = false, simulatedDelayMs = 0) {
  return request(buildTestCircuitApp())
    .post(CIRCUIT_ROUTE)
    .set('Authorization', `Bearer ${apiKey}`)
    .send({ forceFailure, simulatedDelayMs });
}

interface ProviderStatus {
  provider: string;
  state: 'closed' | 'open' | 'half_open';
  openedAt: number;
  consecutiveSuccesses: number;
  trialInFlight: number;
  failureCount: number;
  upstreamCalls: number;
}

async function getProviderStatus(): Promise<ProviderStatus> {
  const res = await request(app).get(STATUS_ROUTE);
  expect(res.status).toBe(200);

  const provider = (res.body.providers as ProviderStatus[]).find((p) => p.provider === PROVIDER);
  expect(provider).toBeDefined();
  return provider!;
}

async function tripCircuitOpen(apiKey: string): Promise<void> {
  for (let i = 0; i < TEST_FAILURE_THRESHOLD; i += 1) {
    const res = await callTestCircuit(apiKey, true);
    expect(res.status).toBe(502);
  }

  const status = await getProviderStatus();
  expect(status.state).toBe('open');
}

describe('Circuit breaker middleware + temporary simulated upstream route', () => {
  it('closed state allows requests and increments simulated upstream call count', async () => {
    const apiKey = await signupTenant();

    const first = await callTestCircuit(apiKey, false);
    expect(first.status).toBe(200);

    const second = await callTestCircuit(apiKey, false);
    expect(second.status).toBe(200);

    const status = await getProviderStatus();
    expect(status.state).toBe('closed');
    expect(status.upstreamCalls).toBe(2);
    expect(status.failureCount).toBe(0);
  });

  it('opens the circuit after threshold failures within the window', async () => {
    const apiKey = await signupTenant();

    await tripCircuitOpen(apiKey);

    const status = await getProviderStatus();
    expect(status.state).toBe('open');
    expect(status.failureCount).toBeGreaterThanOrEqual(TEST_FAILURE_THRESHOLD);
    expect(status.openedAt).toBeGreaterThan(0);
  });

  it('while open, requests short-circuit with 503 and do not call simulated upstream', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    const before = await getProviderStatus();
    const denied = await callTestCircuit(apiKey, false);
    const after = await getProviderStatus();

    expect(denied.status).toBe(503);
    expect(denied.body.error).toBe('Service temporarily unavailable');
    expect(after.upstreamCalls).toBe(before.upstreamCalls);
  });

  it('after cooldown, next request is allowed as a half-open trial', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 300));

    const trial = await callTestCircuit(apiKey, false);
    expect(trial.status).toBe(200);

    const status = await getProviderStatus();
    expect(status.state).toBe('half_open');
    expect(status.consecutiveSuccesses).toBe(1);
    expect(status.trialInFlight).toBe(0);
  });

  it('at the open->half_open boundary, only one concurrent request is allowed', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 300));

    // Fire a burst exactly at the recovery boundary. Atomic CHECK logic should
    // allow one request to acquire half-open trial and deny the rest.
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => callTestCircuit(apiKey, false, 200)),
    );

    const successCount = burst.filter((r) => r.status === 200).length;
    const denyCount = burst.filter((r) => r.status === 503).length;

    expect(successCount).toBe(1);
    expect(denyCount).toBe(5);

    const status = await getProviderStatus();
    expect(status.state).toBe('half_open');
    expect(status.consecutiveSuccesses).toBe(1);
  });

  it('two sequential half-open successes close the circuit', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 300));

    const firstTrial = await callTestCircuit(apiKey, false);
    expect(firstTrial.status).toBe(200);

    const secondTrial = await callTestCircuit(apiKey, false);
    expect(secondTrial.status).toBe(200);

    const closed = await getProviderStatus();
    expect(closed.state).toBe('closed');
    expect(closed.consecutiveSuccesses).toBe(0);

    const normal = await callTestCircuit(apiKey, false);
    expect(normal.status).toBe(200);
  });

  it('half-open trial failure reopens the circuit and resets cooldown', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    await new Promise((resolve) => setTimeout(resolve, TEST_COOLDOWN_MS + 300));

    const failedTrial = await callTestCircuit(apiKey, true);
    expect(failedTrial.status).toBe(502);

    const statusAfterFailure = await getProviderStatus();
    expect(statusAfterFailure.state).toBe('open');

    // Cooldown should have reset from now, so immediate retry must still deny.
    const immediate = await callTestCircuit(apiKey, false);
    expect(immediate.status).toBe(503);
  });

  it('fails open when Redis script execution errors (requests still pass + log marker)', async () => {
    const apiKey = await signupTenant();
    const redis = getRedis();

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const evalShaSpy = jest.spyOn(redis, 'evalsha').mockRejectedValue(new Error('Redis unavailable'));
    const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValue(new Error('Redis unavailable'));

    try {
      const res = await callTestCircuit(apiKey, false);
      expect(res.status).toBe(200);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[CIRCUIT-DEGRADED] Redis error during circuit check — allowing request through (fail-open):'),
        'Redis unavailable',
      );
    } finally {
      evalShaSpy.mockRestore();
      evalSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('POST /admin/circuit/reset resets an open circuit back to closed', async () => {
    const apiKey = await signupTenant();
    await tripCircuitOpen(apiKey);

    const resetRes = await request(app).post(RESET_ROUTE).send({ provider: PROVIDER });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.ok).toBe(true);

    const status = await getProviderStatus();
    expect(status.state).toBe('closed');
    expect(status.failureCount).toBe(0);
    expect(status.consecutiveSuccesses).toBe(0);
  });
});
