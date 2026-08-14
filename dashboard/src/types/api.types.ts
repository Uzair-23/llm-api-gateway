export interface TenantData {
  id: string;
  email: string;
  planTier: 'free' | 'pro';
  rateLimitPerMin: number;
  createdAt?: string;
  apiKeyPrefix?: string;
}

export interface AuthResponse {
  token: string;
  tenant: TenantData;
  apiKey?: string;
}

export interface RotateKeyResponse {
  apiKey: string;
  apiKeyPrefix: string;
}

export interface UsageTimeSeriesPoint {
  time: string;
  requests: number;
  cacheHits: number;
}

export interface ProviderDistributionPoint {
  name: string;
  value: number;
}

export interface UsageStatsResponse {
  totalRequests: number;
  cacheHitRate: number;
  averageLatencyMs: number;
  requestsOverTime: UsageTimeSeriesPoint[];
  providerDistribution: ProviderDistributionPoint[];
}

export interface LimitResponse {
  planTier: 'free' | 'pro';
  rateLimitPerMin: number;
  currentUsage: number;
  resetAt: string;
}
