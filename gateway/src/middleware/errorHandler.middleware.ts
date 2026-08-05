import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../utils/errors';

/**
 * Centralized error handler — must be registered LAST (after all routes).
 *
 * Controllers throw typed `HttpError` subclasses (or pass them to `next`),
 * so this is the single place that translates errors into HTTP responses.
 * Zod validation errors are mapped to 400 with a readable message.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => i.message).join('; ');
    res.status(400).json({ error: message });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Unexpected error — log full detail server-side, leak nothing to client.
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
