import Redis from 'ioredis';
import { config } from '../config';
import logger from '../utils/logger';

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });

    redisClient.on('connect', () => logger.info('✅ Redis connected'));
    redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
  }
  return redisClient;
}

export class CacheService {
  private redis: Redis;

  constructor() {
    this.redis = getRedis();
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch (err: any) {
      logger.warn('Cache GET failed', { key, error: err.message });
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, serialized);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch (err: any) {
      logger.warn('Cache SET failed', { key, error: err.message });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err: any) {
      logger.warn('Cache DEL failed', { key, error: err.message });
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (err: any) {
      logger.warn('Cache pattern invalidation failed', { pattern, error: err.message });
    }
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (ttlSeconds && count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
