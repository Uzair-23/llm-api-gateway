import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUsageLog extends Document {
  tenantId: Types.ObjectId;
  timestamp: Date;
  endpoint: string;
  provider: 'groq' | 'gemini' | null;
  cacheHit: boolean;
  tokensUsed: number;
  latencyMs: number;
  statusCode: number;
}

const usageLogSchema = new Schema<IUsageLog>(
  {
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
    },
    provider: {
      type: String,
      enum: ['groq', 'gemini', null],
      default: null,
    },
    cacheHit: {
      type: Boolean,
      required: true,
      default: false,
    },
    tokensUsed: {
      type: Number,
      default: 0,
    },
    latencyMs: {
      type: Number,
      required: true,
    },
    statusCode: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: false,
  },
);

// Compound index for querying per-tenant logs sorted by timestamp
usageLogSchema.index({ tenantId: 1, timestamp: -1 });

export const UsageLog = mongoose.model<IUsageLog>('UsageLog', usageLogSchema);
