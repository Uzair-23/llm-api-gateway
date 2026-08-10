import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import app from '../../gateway/src/index';
import { Tenant } from '../../gateway/src/models/Tenant.model';
import { generateApiKey, hashApiKey } from '../../gateway/src/utils/apiKey';

// Env vars (JWT_SECRET, MONGO_URI, etc.) are set in tests/jest.setup.ts,
// which runs before this file is loaded — the app import below triggers
// zod env validation at module-load time.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  await Tenant.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const validBody = { email: 'user@example.com', password: 'password123' };

/**
 * Helper: sign up and return the parsed response (tenant JWT + raw API key).
 */
async function signupAndGetKey() {
  const res = await request(app).post('/auth/signup').send(validBody);
  if (res.status !== 201) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token as string,
    apiKey: res.body.apiKey as string,
    tenantId: res.body.tenant.id as string,
  };
}

describe('API key generation on signup', () => {
  it('includes a raw apiKey matching /^sk-live-[a-f0-9]{32}$/', async () => {
    const res = await request(app).post('/auth/signup').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toEqual(expect.any(String));
    expect(res.body.apiKey).toMatch(/^sk-live-[a-f0-9]{32}$/);
  });

  it('stores only the SHA256 hash + prefix, never the raw key', async () => {
    const { apiKey, tenantId } = await signupAndGetKey();

    const stored = await Tenant.findById(tenantId).lean();
    expect(stored).not.toBeNull();
    const doc = JSON.stringify(stored);

    // The raw key must not appear anywhere in the persisted document.
    expect(doc).not.toContain(apiKey);
    // The hash + prefix must be present.
    expect(stored!.apiKeyHash).toEqual(expect.any(String));
    expect(stored!.apiKeyPrefix).toEqual(expect.any(String));
    expect(stored!.apiKeyPrefix).toBe(apiKey.slice(0, 12));
    // The stored hash must be a 64-char SHA256 hex digest, not the raw key
    // and not a bcrypt $2b$ pattern.
    expect(stored!.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored!.apiKeyHash).not.toMatch(/^\$2[ab]\$/);
    expect(stored!.apiKeyHash).not.toBe(apiKey);
    // The stored hash must equal the deterministic SHA256 of the raw key.
    expect(stored!.apiKeyHash).toBe(hashApiKey(apiKey));
  });

  it('produces the SAME hash for the SAME raw key (deterministic)', async () => {
    // This is the property the entire cache-aside design depends on: the
    // auth middleware re-hashes the inbound raw key and uses the digest as a
    // Redis lookup key. If hashing were non-deterministic (as bcrypt is),
    // the same key would never hit its own cache entry. Prove it explicitly.
    const { hash: hash1 } = generateApiKey();
    const { rawKey, hash: hash2 } = generateApiKey();

    // Two different keys must produce two different hashes.
    expect(hash1).not.toBe(hash2);

    // The SAME raw key must always produce the SAME hash.
    const reHashed = hashApiKey(rawKey);
    expect(reHashed).toBe(hash2);
    expect(hashApiKey(rawKey)).toBe(hashApiKey(rawKey));
  });
});

describe('POST /auth/api-key/rotate', () => {
  it('returns a new key different from the original (valid JWT)', async () => {
    const { token, apiKey } = await signupAndGetKey();

    const res = await request(app)
      .post('/auth/api-key/rotate')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toEqual(expect.any(String));
    expect(res.body.apiKey).toMatch(/^sk-live-[a-f0-9]{32}$/);
    expect(res.body.apiKey).not.toBe(apiKey);

    // The persisted hash + prefix should now reflect the NEW key.
    const stored = await Tenant.findOne({ email: validBody.email }).lean();
    expect(stored).not.toBeNull();
    expect(stored!.apiKeyPrefix).toBe(res.body.apiKey.slice(0, 12));
    // Stored hash must be the SHA256 of the NEW raw key.
    expect(stored!.apiKeyHash).toBe(hashApiKey(res.body.apiKey));
    // Old raw key must not match the new stored hash.
    expect(stored!.apiKeyHash).not.toBe(apiKey);
  });

  it('returns 401 without a JWT', async () => {
    const res = await request(app).post('/auth/api-key/rotate').send();

    expect(res.status).toBe(401);
  });

  it('invalidates the old key immediately after rotation', async () => {
    const { token, apiKey } = await signupAndGetKey();

    // The old key should authenticate before rotation.
    const before = await request(app)
      .get('/v1/health/protected')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(200);

    await request(app)
      .post('/auth/api-key/rotate')
      .set('Authorization', `Bearer ${token}`)
      .send();

    // After rotation, the OLD key must immediately fail auth (401).
    const after = await request(app)
      .get('/v1/health/protected')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(after.status).toBe(401);
  });
});
