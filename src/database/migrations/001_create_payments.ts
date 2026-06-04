import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Enable UUID extension
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('merchant_id').notNullable().index();
    table.uuid('customer_id').notNullable().index();
    table.string('order_id', 255).notNullable().index();
    table.bigInteger('amount').notNullable().comment('Amount in smallest currency unit (cents)');
    table.string('currency', 3).notNullable().defaultTo('USD');
    table.string('status', 50).notNullable().defaultTo('pending').index();
    table.string('method', 50).notNullable();
    table.string('provider', 50).notNullable().defaultTo('stripe');
    table.string('provider_payment_id', 255).nullable().unique();
    table.string('provider_customer_id', 255).nullable();
    table.text('description').nullable();
    table.jsonb('metadata').nullable();
    table.string('idempotency_key', 255).notNullable().unique();
    table.string('failure_code', 100).nullable();
    table.text('failure_message').nullable();
    table.timestamp('captured_at').nullable();
    table.bigInteger('refunded_amount').notNullable().defaultTo(0);
    table.timestamps(true, true);

    table.index(['merchant_id', 'status']);
    table.index(['merchant_id', 'created_at']);
    table.index(['customer_id', 'created_at']);
    table.index(['order_id', 'merchant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payments');
}
