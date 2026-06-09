import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/CacheService';
import { config } from '../config';
import logger from '../utils/logger';

const cache = new CacheService();

/**
 * Idempotency middleware — caches full HTTP responses by Idempotency-Key header.
 * Applies only to POST requests.
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== 'POST') {return next();}

  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (!idempotencyKey) {return next();}

  const cacheKey = `idempotency:${idempotencyKey}`;

  try {
    const cached = await cache.get<{ status: number; body: unknown }>(cacheKey);
    if (cached) {
      logger.debug('Returning cached idempotent response', { key: idempotencyKey });
      res.setHeader('X-Idempotency-Replayed', 'true');
      res.status(cached.status).json(cached.body);
      return;
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 500) {
        void cache
          .set(cacheKey, { status: res.statusCode, body }, config.idempotency.ttlSeconds)
          .catch((err: unknown) => logger.warn('Failed to cache idempotent response', { error: err instanceof Error ? err.message : String(err) }));
      }
      return originalJson(body);
    };

    next();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('Idempotency middleware error', { error: errMsg });
    next();
  }
}
