import mongoose, { Schema, Document } from 'mongoose';

/**
 * Tenant document shape.
 *
 * `apiKeyHash` is a SHA256 hex digest (64 chars) of the raw API key, NOT a
 * bcrypt hash. As of Phase 2 we migrated from bcrypt to SHA256 for API keys
 * because bcrypt is salted/non-deterministic and cannot serve as a Redis
 * cache-aside lookup key. `passwordHash` remains bcrypt — do not change that.
 * Any pre-migration test tenants with bcrypt-style apiKeyHash values should
 * be deleted manually (this is pre-production test data).
 */
export interface ITenant extends Document {
  email: string;
  passwordHash: string;
  planTier: 'free' | 'pro';
  rateLimitPerMin: number;
  apiKeyHash: string;
  apiKeyPrefix: string;
  createdAt: Date;
}

const tenantSchema = new Schema<ITenant>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // Lightweight format validation at the DB layer as a defense-in-depth
      // measure. The authoritative validation lives in the zod schema, but
      // a DB-level guard catches any code path that bypasses it.
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, '{VALUE} is not a valid email'],
    },
    passwordHash: {
      type: String,
      required: true,
    },
    planTier: {
      type: String,
      enum: ['free', 'pro'],
      default: 'free',
    },
    rateLimitPerMin: {
      type: Number,
      default: 100,
    },
    apiKeyHash: {
      type: String,
      required: true,
    },
    apiKeyPrefix: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    // Avoid leaking the bcrypt hash in any default toJSON path.
    toJSON: {
      transform: (_doc, ret) => {
        const sanitized = ret as Record<string, unknown>;
        delete sanitized.passwordHash;
        delete sanitized.apiKeyHash;
        delete sanitized.apiKeyPrefix;
        delete sanitized.__v;
        return sanitized;
      },
    },
  },
);

export const Tenant = mongoose.model<ITenant>('Tenant', tenantSchema);
