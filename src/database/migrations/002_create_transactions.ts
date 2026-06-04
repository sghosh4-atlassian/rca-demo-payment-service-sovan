import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('payment_id').notNullable().references('id').inTable('payments').onDelete('RESTRICT');
    table.string('type', 50).notNullable().index();
    table.bigInteger('amount').notNullable();
    table.string('currency', 3).notNullable();
    table.string('status', 50).notNullable().index();
    table.string('provider_transaction_id', 255).nullable().unique();
    table.bigInteger('fee').nullable();
    table.bigInteger('net').nullable();
    table.jsonb('metadata').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.index(['payment_id', 'type']);
    table.index(['payment_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('transactions');
}
