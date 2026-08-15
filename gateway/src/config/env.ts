import dotenv from 'dotenv';
import { existsSync } from 'fs';
import path from 'path';
import { z } from 'zod';

// Load the gateway's .env explicitly so the app resolves the correct values
// even when the process is started from the repo root instead of the gateway
// directory. This avoids the common "GROQ_API_KEY is not configured" error in
// local and production runs.
const candidatePaths = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(process.cwd(), '.env'),
].filter((candidate, index, array) => array.indexOf(candidate) === index);

const envPath = candidatePaths.find((candidate) => existsSync(candidate));
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

/**
 * Centralized environment variable validation.
 * Fail fast and loud at startup if a required var is missing or malformed —
 * never let the app start in a half-configured state.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  INSTANCE_ID: z.string().optional().default('local'),
  MONGO_URI: z.string().url().or(z.string().min(1)),
  REDIS_URL: z.string().url().or(z.string().min(1)),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  GROQ_API_KEY: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Print a readable error and exit — do not start with invalid config.
  console.error('❌ Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;
