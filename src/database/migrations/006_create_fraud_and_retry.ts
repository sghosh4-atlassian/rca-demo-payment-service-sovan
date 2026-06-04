import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── fraud_assessments ──────────────────────────────────────────────────────
  await knex.schema.createTable('fraud_assessments', (table) => {
    table.uuid('payment_id').primary()
      .references('id').inTable('payments').onDelete('CASCADE');
    table.uuid('customer_id').notNullable().index();
    table.uuid('merchant_id').notNullable().index();
    table.integer('score').notNullable().comment('0–100 risk score');
    table.string('risk_level', 20).notNullable().index(); // low | medium | high
    table.jsonb('signals').notNullable().defaultTo('[]');
    table.boolean('blocked').notNullable().defaultTo(false);
    table.boolean('requires_review').notNullable().defaultTo(false);
    table.timestamp('assessed_at').notNullable().defaultTo(knex.fn.now());

    table.index(['merchant_id', 'risk_level']);
    table.index(['customer_id', 'assessed_at']);
  });

  // ── retry_attempts ─────────────────────────────────────────────────────────
  await knex.schema.createTable('retry_attempts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('payment_id').notNullable()
      .references('id').inTable('payments').onDelete('CASCADE');
    table.integer('attempt_number').notNullable();
    table.string('status', 20).notNullable().defaultTo('pending').index();
    table.string('failure_code', 100).nullable();
    table.text('failure_message').nullable();
    table.timestamp('scheduled_at').notNullable();
    table.timestamp('executed_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    table.unique(['payment_id', 'attempt_number']);
    table.index(['payment_id', 'status']);
    table.index(['scheduled_at']); // for job queue polling
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('retry_attempts');
  await knex.schema.dropTableIfExists('fraud_assessments');
}
