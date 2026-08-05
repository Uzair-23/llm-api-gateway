import { z } from 'zod';

/**
 * Zod schemas for the auth request bodies.
 * These are the authoritative input-validation layer; the Mongoose schema
 * only acts as a defense-in-depth backstop.
 */

export const signupBodySchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const loginBodySchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export type SignupBody = z.infer<typeof signupBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
