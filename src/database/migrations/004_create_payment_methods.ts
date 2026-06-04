import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payment_methods', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('customer_id').notNullable().index();
    table.string('type', 50).notNullable();
    table.string('provider', 50).notNullable();
    table.string('provider_method_id', 255).notNullable().unique();
    table.string('last4', 4).nullable();
    table.string('brand', 50).nullable();
    table.smallint('expiry_month').nullable();
    table.smallint('expiry_year').nullable();
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.jsonb('billing_address').nullable();
    table.timestamps(true, true);

    table.index(['customer_id', 'is_active']);
    table.index(['customer_id', 'is_default']);
  });

  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('merchant_id').notNullable().index();
    table.string('external_id', 255).notNullable();
    table.string('email', 320).notNullable().index();
    table.string('name', 255).nullable();
    table.string('phone', 50).nullable();
    table.string('provider_customer_id', 255).nullable();
    table.jsonb('metadata').nullable();
    table.timestamps(true, true);

    table.unique(['merchant_id', 'external_id']);
    table.index(['merchant_id', 'email']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payment_methods');
  await knex.schema.dropTableIfExists('customers');
}
