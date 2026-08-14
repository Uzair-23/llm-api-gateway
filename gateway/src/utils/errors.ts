/**
 * Typed application errors used by controllers to signal failures to the
 * centralized errorHandler middleware via `next(err)`. This keeps controllers
 * free of inline `res.status().json()` calls and makes the HTTP status code
 * + message a single, intentional decision.
 */

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, message, details);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(401, message, details);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(404, message, details);
    this.name = 'NotFoundError';
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(503, message, details);
    this.name = 'ServiceUnavailableError';
  }
}
