import knex, { Knex } from 'knex';
import { config } from '../config';
import logger from '../utils/logger';

let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: {
        host: config.db.host,
        port: config.db.port,
        database: config.db.name,
        user: config.db.user,
        password: config.db.password,
        ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
      },
      pool: {
        min: config.db.poolMin,
        max: config.db.poolMax,
        afterCreate: (conn: Record<string, unknown>, done: (err: Error | null, conn: Record<string, unknown>) => void) => {
          (conn as Record<string, unknown> & { query: (sql: string, callback: (err: Error | null) => void) => void }).query('SET timezone = "UTC";', (err: Error | null) => done(err, conn));
        },
      },
      acquireConnectionTimeout: 10_000,
    });

    db.on('query', (query: Record<string, unknown>) => {
      if (config.isDev) {
        logger.debug('DB Query', { sql: String(query.sql), bindings: query.bindings });
      }
    });

    db.on('query-error', (error: Record<string, unknown>, query: Record<string, unknown>) => {
      logger.error('DB Query Error', { error: String(error.message), sql: String(query.sql) });
    });
  }
  return db;
}

export async function connectDb(): Promise<void> {
  try {
    const database = getDb();
    await database.raw('SELECT 1');
    logger.info('✅ Database connection established', {
      host: config.db.host,
      database: config.db.name,
    });
  } catch (err) {
    logger.error('❌ Database connection failed', { error: err });
    throw err;
  }
}

export async function disconnectDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
    logger.info('Database connection closed');
  }
}
