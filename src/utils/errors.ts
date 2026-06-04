// ─────────────────────────────────────────────────────────────────────────────
// Custom Application Errors
// ─────────────────────────────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    errorCode: string,
    isOperational = true,
    details?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.details = details;
    Error.captureStackTrace(this);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', true, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const msg = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(msg, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

export class PaymentError extends AppError {
  constructor(message: string, errorCode = 'PAYMENT_FAILED', details?: unknown) {
    super(message, 422, errorCode, true, details);
  }
}

export class ProviderError extends AppError {
  constructor(provider: string, message: string, details?: unknown) {
    super(`[${provider}] ${message}`, 502, 'PROVIDER_ERROR', true, details);
  }
}

export class IdempotencyError extends AppError {
  constructor(key: string) {
    super(`Request with idempotency key '${key}' already processed`, 409, 'IDEMPOTENCY_CONFLICT');
  }
}

export class InsufficientFundsError extends AppError {
  constructor() {
    super('Insufficient funds', 422, 'INSUFFICIENT_FUNDS');
  }
}

export class RefundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'REFUND_FAILED', true, details);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super('Too many requests, please try again later', 429, 'RATE_LIMIT_EXCEEDED');
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
