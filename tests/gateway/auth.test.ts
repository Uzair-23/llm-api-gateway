import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../../gateway/src/index';
import { Tenant } from '../../gateway/src/models/Tenant.model';

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
  // Clean tenants between tests so each test is independent.
  await Tenant.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('POST /auth/signup', () => {
  const validBody = { email: 'user@example.com', password: 'password123' };

  it('returns 201, a JWT, and does NOT return passwordHash', async () => {
    const res = await request(app).post('/auth/signup').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.tenant).toBeDefined();
    expect(res.body.tenant.email).toBe(validBody.email);
    expect(res.body.tenant.planTier).toBe('free');
    expect(res.body.tenant.rateLimitPerMin).toBe(100);
    // passwordHash must never leak on the wire.
    expect(res.body.tenant.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');

    // The token should be a verifiable JWT with the expected payload shape.
    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET!) as {
      tenantId: string;
      email: string;
    };
    expect(decoded.email).toBe(validBody.email);
    expect(decoded.tenantId).toEqual(expect.any(String));
  });

  it('returns 409 on duplicate email', async () => {
    await request(app).post('/auth/signup').send(validBody);
    const res = await request(app).post('/auth/signup').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('returns 400 on invalid email format', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is under 8 chars', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'short@example.com', password: 'short' });

    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  const email = 'user@example.com';
  const password = 'password123';

  beforeEach(async () => {
    await request(app).post('/auth/signup').send({ email, password });
  });

  it('returns 200 and a valid JWT on successful login', async () => {
    const res = await request(app).post('/auth/login').send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.tenant.email).toBe(email);
    expect(res.body.tenant.passwordHash).toBeUndefined();

    const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET!) as {
      tenantId: string;
      email: string;
    };
    expect(decoded.email).toBe(email);
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('returns 401 on non-existent email with the SAME message as wrong password', async () => {
    const wrongPwRes = await request(app)
      .post('/auth/login')
      .send({ email, password: 'wrong-password' });
    const noUserRes = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });

    expect(wrongPwRes.status).toBe(401);
    expect(noUserRes.status).toBe(401);
    // Identical message prevents user enumeration.
    expect(noUserRes.body.error).toBe(wrongPwRes.body.error);
  });
});
