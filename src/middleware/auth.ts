import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

export interface AuthPayload {
  merchantId: string;
  sub: string;
  role: 'admin' | 'merchant' | 'readonly';
  iat: number;
  exp: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthPayload;
  }
}

/**
 * Validates the Bearer JWT in Authorization header.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or invalid Authorization header'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret) as AuthPayload;
    req.auth = payload;
    next();
  } catch (err: unknown) {
    if (err instanceof jwt.JsonWebTokenError && err.name === 'TokenExpiredError') {
      next(new UnauthorizedError('Token has expired'));
    } else {
      next(new UnauthorizedError('Invalid token'));
    }
  }
}

/**
 * Restricts access to specific roles.
 */
export function authorize(...roles: AuthPayload['role'][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {return next(new UnauthorizedError());}
    if (!roles.includes(req.auth.role)) {
      return next(new ForbiddenError(`Role '${req.auth.role}' is not permitted`));
    }
    next();
  };
}

/**
 * Ensures the request's merchantId matches the authenticated merchant.
 */
export function requireMerchantOwnership(req: Request, _res: Response, next: NextFunction): void {
  const { merchantId } = req.params;
  if (!req.auth) {return next(new UnauthorizedError());}
  if (req.auth.role !== 'admin' && req.auth.merchantId !== merchantId) {
    return next(new ForbiddenError('Access denied to this merchant resource'));
  }
  next();
}
