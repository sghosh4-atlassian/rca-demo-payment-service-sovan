import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const optionalInt = (key: string, fallback: number): number => {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
};

// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  env: optional('NODE_ENV', 'development'),
  isDev: optional('NODE_ENV', 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  server: {
    port: optionalInt('PORT', 3000),
    apiVersion: optional('API_VERSION', 'v1'),
    serviceName: optional('SERVICE_NAME', 'payment-service'),
  },

  db: {
    host: optional('DB_HOST', 'localhost'),
    port: optionalInt('DB_PORT', 5432),
    name: optional('DB_NAME', 'payment_service_db'),
    user: optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', ''),
    poolMin: optionalInt('DB_POOL_MIN', 2),
    poolMax: optionalInt('DB_POOL_MAX', 10),
    ssl: optional('DB_SSL', 'false') === 'true',
  },

  redis: {
    host: optional('REDIS_HOST', 'localhost'),
    port: optionalInt('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', ''),
    db: optionalInt('REDIS_DB', 0),
  },

  jwt: {
    secret: optional('JWT_SECRET', 'changeme'),
    expiresIn: optional('JWT_EXPIRES_IN', '1h'),
    refreshSecret: optional('JWT_REFRESH_SECRET', 'changeme-refresh'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY', ''),
    publishableKey: optional('STRIPE_PUBLISHABLE_KEY', ''),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
  },

  paypal: {
    clientId: optional('PAYPAL_CLIENT_ID', ''),
    clientSecret: optional('PAYPAL_CLIENT_SECRET', ''),
    mode: optional('PAYPAL_MODE', 'sandbox') as 'sandbox' | 'live',
  },

  encryption: {
    key: optional('ENCRYPTION_KEY', '12345678901234567890123456789012'),
    iv: optional('ENCRYPTION_IV', '1234567890123456'),
  },

  rateLimit: {
    windowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000),
    maxRequests: optionalInt('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  logging: {
    level: optional('LOG_LEVEL', 'info'),
    filePath: optional('LOG_FILE_PATH', './logs/app.log'),
  },

  email: {
    host: optional('SMTP_HOST', ''),
    port: optionalInt('SMTP_PORT', 587),
    user: optional('SMTP_USER', ''),
    password: optional('SMTP_PASSWORD', ''),
    from: optional('EMAIL_FROM', 'noreply@example.com'),
  },

  webhook: {
    retryAttempts: optionalInt('WEBHOOK_RETRY_ATTEMPTS', 3),
    retryDelayMs: optionalInt('WEBHOOK_RETRY_DELAY_MS', 5000),
  },

  idempotency: {
    ttlSeconds: optionalInt('IDEMPOTENCY_KEY_TTL_SECONDS', 86400),
  },
} as const;
