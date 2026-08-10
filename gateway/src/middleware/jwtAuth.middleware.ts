import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { UnauthorizedError } from '../utils/errors';

/**
 * JWT auth middleware for dashboard / human-session routes.
 *
 * Extracts a Bearer token from the Authorization header, verifies it, and
 * attaches the decoded payload to `req.tenant` for downstream handlers.
 * On any failure (missing header, malformed scheme, invalid/expired token)
 * it returns 401 — never distinguishes "no token" from "bad token" to avoid
 * leaking auth state to a probing client.
 */
export function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication required');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedError('Authentication required');
    }

    const payload: JwtPayload = verifyToken(token);
    req.tenant = { tenantId: payload.tenantId, email: payload.email };
    next();
  } catch (err) {
    // Translate any thrown error (including jwt errors) into a uniform 401.
    if (err instanceof UnauthorizedError) {
      next(err);
      return;
    }
    next(new UnauthorizedError('Invalid or expired token'));
  }
}
