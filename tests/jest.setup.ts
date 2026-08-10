// Jest global setup — runs before any test file is loaded.
// Sets the env vars required by the gateway's env schema BEFORE the app
// module is imported in tests. Importing the app triggers zod env validation
// at module-load time, so these must be in place first.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-16-chars';
process.env.MONGO_URI = 'mongodb://localhost:27017/llm-gateway-test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.PORT = '4001';
