import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../database/connection';
import { CacheService } from '../services/CacheService';
import { config } from '../config';

const router = Router();
const cache = new CacheService();

/**
 * GET /health
 * Basic liveness probe — always returns 200 if the process is alive.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: config.server.serviceName,
    version: process.env.npm_package_version ?? '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 * Readiness probe — checks DB and Redis connectivity.
 */
router.get('/ready', (_req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    // Database check
    const dbStart = Date.now();
    try {
      await getDb().raw('SELECT 1');
      checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (err: unknown) {
      checks.database = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    // Redis check
    const redisStart = Date.now();
    try {
      await cache.set('health:ping', 'pong', 5);
      const pong = await cache.get('health:ping');
      checks.redis = pong === 'pong'
        ? { status: 'ok', latencyMs: Date.now() - redisStart }
        : { status: 'error', error: 'Unexpected value from Redis' };
    } catch (err: unknown) {
      checks.redis = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    const allHealthy = Object.values(checks).every((c) => c.status === 'ok');

    res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  })().catch(next);
});

export default router;
