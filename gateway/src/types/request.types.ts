import { Request } from 'express';

/**
 * Augment Express's Request with the authenticated tenant info populated by
 * the auth middlewares.
 *
 * Two middlewares populate `req.tenant` with different subsets:
 *  - `jwtAuth` (dashboard sessions): { tenantId, email }
 *  - `auth` (API-key gateway traffic): { tenantId, planTier, rateLimitPerMin }
 *
 * All fields are optional in the union so a single `req.tenant` works for
 * both. Downstream handlers read only the fields they need.
 */
export interface AuthTenant {
  tenantId: string;
  email?: string;
  planTier?: 'free' | 'pro';
  rateLimitPerMin?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: AuthTenant;
  }
}

export {};
