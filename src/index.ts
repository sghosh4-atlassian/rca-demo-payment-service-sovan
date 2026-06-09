import { createApp } from './app';
import { config } from './config';
import { connectDb, disconnectDb } from './database/connection';
import { disconnectRedis } from './services/CacheService';
import logger from './utils/logger';

async function bootstrap(): Promise<void> {
  logger.info(`Starting ${config.server.serviceName}`, { env: config.env });

  // Connect to dependencies
  await connectDb();

  const app = createApp();
  const server = app.listen(config.server.port, () => {
    logger.info(`🚀 ${config.server.serviceName} running`, {
      port: config.server.port,
      env: config.env,
      apiBase: `/api/${config.server.apiVersion}`,
    });
  });

  // ── Graceful Shutdown ────────────────────────────────────────────────────

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      void (async () => {
        try {
          await disconnectDb();
          await disconnectRedis();
          logger.info('Shutdown complete');
          process.exit(0);
        } catch (err) {
          logger.error('Error during shutdown', { error: err });
          process.exit(1);
        }
      })();
    });

    // Force-kill if graceful shutdown takes too long
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection', { reason });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

void bootstrap().catch((err: unknown) => {
  logger.error('Failed to start service', { error: err });
  process.exit(1);
});
