import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Reusable JWT sign/verify utilities.
 *
 * Phase 1 uses these for dashboard session tokens. Phase 2's `jwtAuth`
 * middleware will reuse `verifyToken` to protect dashboard routes — keep
 * this module free of Express-specific concerns so it stays reusable.
 */

export interface JwtPayload {
  tenantId: string;
  email: string;
}

const EXPIRES_IN = '7d';

/**
 * Sign a JWT containing the tenant id + email, expiring in 7 days.
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: EXPIRES_IN,
  } as SignOptions);
}

/**
 * Verify a JWT and return the typed payload.
 * Throws `jwt.JsonWebTokenError` / `TokenExpiredError` on invalid tokens —
 * callers (e.g. the jwtAuth middleware) are responsible for translating
 * these into 401 responses.
 */
export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  return decoded;
}
