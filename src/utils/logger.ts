import winston from 'winston';
import path from 'path';
import { config } from '../config';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: config.server.serviceName },
  transports: [
    new winston.transports.Console({
      format: config.isDev
        ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFormat)
        : combine(timestamp(), errors({ stack: true }), json()),
    }),
    new winston.transports.File({
      filename: path.resolve(config.logging.filePath),
      format: combine(timestamp(), errors({ stack: true }), json()),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.resolve(config.logging.filePath.replace('.log', '.error.log')),
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
  ],
});

export default logger;

// Convenience helpers
export const logPaymentEvent = (event: string, data: Record<string, unknown>) => {
  logger.info(`[PAYMENT_EVENT] ${event}`, data);
};

export const logSecurityEvent = (event: string, data: Record<string, unknown>) => {
  logger.warn(`[SECURITY_EVENT] ${event}`, data);
};
