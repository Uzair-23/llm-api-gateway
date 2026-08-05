import mongoose, { Schema, Document } from 'mongoose';

/**
 * Tenant document shape.
 *
 * NOTE (Phase 1 scope): `apiKeyHash` and `apiKeyPrefix` are intentionally
 * omitted here — they belong to Phase 2 (API key issuance). Do not add them
 * in this phase; doing so would silently expand scope.
 */
export interface ITenant extends Document {
  email: string;
  passwordHash: string;
  planTier: 'free' | 'pro';
  rateLimitPerMin: number;
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
        delete sanitized.__v;
        return sanitized;
      },
    },
  },
);

export const Tenant = mongoose.model<ITenant>('Tenant', tenantSchema);
