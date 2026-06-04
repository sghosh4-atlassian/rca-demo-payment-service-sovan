import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import paymentsRouter from './routes/payments';
import webhooksRouter from './routes/webhooks';
import healthRouter from './routes/health';
import logger from './utils/logger';

export function createApp(): express.Application {
  const app = express();

  // ── Security ─────────────────────────────────────────────────────────────

  app.use(helmet({
    contentSecurityPolicy: true,
    crossOriginEmbedderPolicy: true,
  }));

  app.use(cors({
    origin: config.isDev ? '*' : (process.env.ALLOWED_ORIGINS ?? '').split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['X-Idempotency-Replayed'],
  }));

  // ── Rate Limiting ─────────────────────────────────────────────────────────

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.maxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' } },
    }),
  );

  // ── Body Parsing ──────────────────────────────────────────────────────────

  // Raw body for Stripe webhook signature verification
  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
  );

  // JSON body for all other routes
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Compression & Logging ─────────────────────────────────────────────────

  app.use(compression());

  app.use(
    morgan(config.isDev ? 'dev' : 'combined', {
      stream: { write: (message) => logger.http(message.trim()) },
      skip: (_req, res) => res.statusCode < 400 && config.isProd,
    }),
  );

  // ── Request ID ────────────────────────────────────────────────────────────

  app.use((req, _res, next) => {
    req.headers['x-request-id'] ??= crypto.randomUUID();
    next();
  });

  // ── Routes ────────────────────────────────────────────────────────────────

  const apiBase = `/api/${config.server.apiVersion}`;

  app.use('/health', healthRouter);
  app.use(`${apiBase}/payments`, paymentsRouter);
  app.use('/webhooks', webhooksRouter);

  // ── Error Handling ────────────────────────────────────────────────────────

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
