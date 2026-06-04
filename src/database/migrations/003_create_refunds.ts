import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('refunds', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('payment_id').notNullable().references('id').inTable('payments').onDelete('RESTRICT');
    table.uuid('merchant_id').notNullable().index();
    table.bigInteger('amount').notNullable();
    table.string('currency', 3).notNullable();
    table.string('status', 50).notNullable().defaultTo('pending').index();
    table.text('reason').nullable();
    table.string('provider_refund_id', 255).nullable().unique();
    table.string('initiated_by', 255).notNullable();
    table.jsonb('metadata').nullable();
    table.timestamps(true, true);

    table.index(['payment_id', 'status']);
    table.index(['merchant_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('refunds');
}
