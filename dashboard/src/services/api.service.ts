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

export async function getUsageStats(): Promise<UsageStatsResponse> {
  const response = await apiClient.get<UsageStatsResponse>('/dashboard/usage');
  return response.data;
}

export async function getLimits(): Promise<LimitResponse> {
  const response = await apiClient.get<LimitResponse>('/dashboard/limits');
  return response.data;
}
