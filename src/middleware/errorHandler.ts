import { Request, Response, NextFunction } from 'express';
import { AppError, isAppError } from '../utils/errors';
import { ApiResponse } from '../types';
import logger from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (isAppError(err)) {
    // Known operational errors — log at warn level
    if (err.statusCode >= 500) {
      logger.error('Operational error', {
        errorCode: err.errorCode,
        message: err.message,
        path: req.path,
        method: req.method,
        stack: err.stack,
      });
    } else {
      logger.warn('Client error', {
        errorCode: err.errorCode,
        message: err.message,
        path: req.path,
        method: req.method,
      });
    }

    const response: ApiResponse = {
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details,
      },
    };
    res.status(err.statusCode).json(response);
    return;
  }

  // Unknown / programmer errors
  logger.error('Unexpected error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  } as ApiResponse);
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  } as ApiResponse);
}
