/**
 * Database migration runner.
 * Usage:
 *   ts-node src/database/migrate.ts           → run all pending migrations
 *   ts-node src/database/migrate.ts rollback  → roll back the last batch
 */
import path from 'path';
import knex from 'knex';
import { config } from '../config';
import logger from '../utils/logger';

const db = knex({
  client: 'pg',
  connection: {
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
  },
  migrations: {
    directory: path.resolve(__dirname, 'migrations'),
    extension: 'ts',
    loadExtensions: ['.ts'],
  },
});

async function run() {
  const command = process.argv[2];

  try {
    if (command === 'rollback') {
      logger.info('Rolling back last migration batch...');
      const [batch, migrations] = await db.migrate.rollback();
      logger.info(`Rolled back batch ${batch}`, { migrations });
    } else {
      logger.info('Running pending migrations...');
      const [batch, migrations] = await db.migrate.latest();
      if (migrations.length === 0) {
        logger.info('No pending migrations');
      } else {
        logger.info(`Ran batch ${batch}`, { migrations });
      }
    }
  } catch (err) {
    logger.error('Migration failed', { error: err });
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

run();
