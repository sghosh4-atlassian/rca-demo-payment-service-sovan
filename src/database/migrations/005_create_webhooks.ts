import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('webhooks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('merchant_id').notNullable().index();
    table.string('url', 2048).notNullable();
    table.specificType('events', 'text[]').notNullable();
    table.string('secret', 255).notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.integer('failure_count').notNullable().defaultTo(0);
    table.timestamp('last_delivered_at').nullable();
    table.timestamps(true, true);
  });

  await knex.schema.createTable('webhook_deliveries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('webhook_id').notNullable().references('id').inTable('webhooks').onDelete('CASCADE');
    table.string('event', 100).notNullable();
    table.jsonb('payload').notNullable();
    table.integer('status_code').nullable();
    table.text('response_body').nullable();
    table.boolean('success').notNullable().defaultTo(false);
    table.integer('attempt').notNullable().defaultTo(1);
    table.timestamp('delivered_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['webhook_id', 'event']);
    table.index(['webhook_id', 'success']);
  });

  await knex.schema.createTable('idempotency_keys', (table) => {
    table.string('key', 255).primary();
    table.uuid('payment_id').nullable();
    table.jsonb('response').nullable();
    table.timestamp('expires_at').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['expires_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotency_keys');
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('webhooks');
}
