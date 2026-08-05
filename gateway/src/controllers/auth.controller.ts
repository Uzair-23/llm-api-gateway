import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { Tenant } from '../models/Tenant.model';
import { signupBodySchema, loginBodySchema } from '../validation/auth.validation';
import { signToken } from '../utils/jwt';
import { ConflictError, UnauthorizedError } from '../utils/errors';

/**
 * Public tenant info returned in auth responses.
 * `passwordHash` is deliberately excluded — never leak it on the wire.
 */
function publicTenant(t: { _id: import('mongoose').Types.ObjectId; email: string; planTier: 'free' | 'pro'; rateLimitPerMin: number; createdAt: Date }) {
  return {
    id: t._id.toString(),
    email: t.email,
    planTier: t.planTier,
    rateLimitPerMin: t.rateLimitPerMin,
    createdAt: t.createdAt,
  };
}

/**
 * POST /auth/signup
 * Validates input, rejects duplicate emails with 409, hashes the password
 * with bcrypt (12 salt rounds), persists the Tenant, and returns a JWT +
 * tenant info. The raw password is never stored or returned.
 */
export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = signupBodySchema.parse(req.body);
    const { email, password } = parsed;

    const existing = await Tenant.findOne({ email });
    if (existing) {
      throw new ConflictError('A tenant with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const tenant = await Tenant.create({ email, passwordHash });

    const token = signToken({ tenantId: tenant._id.toString(), email: tenant.email });
    res.status(201).json({ token, tenant: publicTenant(tenant) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/login
 * Validates input, looks up the tenant by email, and compares the supplied
 * password with the stored bcrypt hash.
 *
 * SECURITY: "user not found" and "wrong password" both return the SAME 401
 * message ("Invalid email or password"). Returning distinct messages would
 * let an attacker enumerate which emails are registered (user enumeration),
 * which is a real attack vector against auth systems. The cost of this
 * choice is a slightly worse UX for legitimate users who typo their email,
 * which is the correct tradeoff for a credential endpoint.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = loginBodySchema.parse(req.body);
    const { email, password } = parsed;

    const tenant = await Tenant.findOne({ email });
    if (!tenant) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const match = await bcrypt.compare(password, tenant.passwordHash);
    if (!match) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const token = signToken({ tenantId: tenant._id.toString(), email: tenant.email });
    res.status(200).json({ token, tenant: publicTenant(tenant) });
  } catch (err) {
    next(err);
  }
}
