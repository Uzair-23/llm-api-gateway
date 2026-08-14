import axios from 'axios';
import type {
  AuthResponse,
  RotateKeyResponse,
  TenantData,
  UsageStatsResponse,
  LimitResponse,
} from '../types/api.types';

const TOKEN_KEY = 'authToken';
const TENANT_KEY = 'tenantInfo';
const API_KEY_PREFIX_KEY = 'apiKeyPrefix';

export const apiClient = axios.create({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auth helper functions
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getTenant(): TenantData | null {
  const raw = localStorage.getItem(TENANT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setTenant(tenant: TenantData): void {
  localStorage.setItem(TENANT_KEY, JSON.stringify(tenant));
}

export function getApiKeyPrefix(): string | null {
  return localStorage.getItem(API_KEY_PREFIX_KEY);
}

export function setApiKeyPrefix(prefix: string): void {
  localStorage.setItem(API_KEY_PREFIX_KEY, prefix);
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TENANT_KEY);
  localStorage.removeItem(API_KEY_PREFIX_KEY);
}

export function isAuthenticated(): boolean {
  return Boolean(getToken());
}

// API Service Methods
export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await apiClient.post<AuthResponse>('/auth/login', { email, password });
  const data = response.data;
  if (data.token) setToken(data.token);
  if (data.tenant) setTenant(data.tenant);
  if (data.tenant?.apiKeyPrefix) setApiKeyPrefix(data.tenant.apiKeyPrefix);
  return data;
}

export async function signup(email: string, password: string): Promise<AuthResponse> {
  const response = await apiClient.post<AuthResponse>('/auth/signup', { email, password });
  const data = response.data;
  if (data.token) setToken(data.token);
  if (data.tenant) setTenant(data.tenant);
  if (data.apiKey) {
    const prefix = data.apiKey.slice(0, 11) + '...';
    setApiKeyPrefix(prefix);
  }
  return data;
}

export async function rotateKey(): Promise<RotateKeyResponse> {
  const response = await apiClient.post<RotateKeyResponse>('/auth/api-key/rotate');
  const data = response.data;
  if (data.apiKeyPrefix) {
    setApiKeyPrefix(data.apiKeyPrefix);
  } else if (data.apiKey) {
    const prefix = data.apiKey.slice(0, 11) + '...';
    setApiKeyPrefix(prefix);
  }
  return data;
}

/**
 * TODO(Backend Team): Connect to live GET /dashboard/usage endpoint once implemented.
 * Falls back to structured mock data for recharts analytics when offline / not yet mounted on server.
 */
export async function getUsageStats(): Promise<UsageStatsResponse> {
  try {
    const response = await apiClient.get<UsageStatsResponse>('/dashboard/usage');
    return response.data;
  } catch (_err) {
    // Return realistic fallback analytics data for client display
    return {
      totalRequests: 1420,
      cacheHitRate: 68.4,
      averageLatencyMs: 142,
      requestsOverTime: [
        { time: '00:00', requests: 45, cacheHits: 30 },
        { time: '04:00', requests: 20, cacheHits: 14 },
        { time: '08:00', requests: 180, cacheHits: 120 },
        { time: '12:00', requests: 420, cacheHits: 290 },
        { time: '16:00', requests: 510, cacheHits: 350 },
        { time: '20:00', requests: 245, cacheHits: 168 },
      ],
      providerDistribution: [
        { name: 'Groq (Primary)', value: 85 },
        { name: 'Gemini (Fallback)', value: 15 },
      ],
    };
  }
}

/**
 * TODO(Backend Team): Connect to live GET /dashboard/limits endpoint once implemented.
 * Falls back to structured mock data for rate limit & quota display.
 */
export async function getLimits(): Promise<LimitResponse> {
  try {
    const response = await apiClient.get<LimitResponse>('/dashboard/limits');
    return response.data;
  } catch (_err) {
    const tenant = getTenant();
    const rateLimitPerMin = tenant?.rateLimitPerMin ?? 100;
    return {
      planTier: tenant?.planTier ?? 'free',
      rateLimitPerMin,
      currentUsage: 34,
      resetAt: new Date(Date.now() + 26 * 1000).toISOString(),
    };
  }
}
