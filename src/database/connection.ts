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
        afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
          conn.query('SET timezone = "UTC";', (err: Error) => done(err, conn));
        },
      },
      acquireConnectionTimeout: 10_000,
    });

    db.on('query', (query) => {
      if (config.isDev) {
        logger.debug('DB Query', { sql: query.sql, bindings: query.bindings });
      }
    });

    db.on('query-error', (error, query) => {
      logger.error('DB Query Error', { error: error.message, sql: query.sql });
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
