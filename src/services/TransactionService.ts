import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import { Transaction, TransactionType, PaymentStatus, Currency } from '../types';
import { NotFoundError } from '../utils/errors';

interface CreateTransactionInput {
  paymentId: string;
  type: TransactionType;
  amount: number;
  currency: Currency | string;
  status: PaymentStatus;
  providerTransactionId?: string;
  fee?: number;
  net?: number;
  metadata?: Record<string, unknown>;
}

export class TransactionService {
  async createTransaction(input: CreateTransactionInput): Promise<Transaction> {
    const db = getDb();
    const [row] = await db('transactions')
      .insert({
        id: uuidv4(),
        payment_id: input.paymentId,
        type: input.type,
        amount: input.amount,
        currency: input.currency,
        status: input.status,
        provider_transaction_id: input.providerTransactionId ?? null,
        fee: input.fee ?? null,
        net: input.net ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      })
      .returning('*');

    return this.toTransaction(row);
  }

  async getTransactionById(id: string): Promise<Transaction> {
    const db = getDb();
    const row = await db('transactions').where({ id }).first();
    if (!row) throw new NotFoundError('Transaction', id);
    return this.toTransaction(row);
  }

  async listTransactionsByPayment(paymentId: string): Promise<Transaction[]> {
    const db = getDb();
    const rows = await db('transactions')
      .where({ payment_id: paymentId })
      .orderBy('created_at', 'asc');
    return rows.map(this.toTransaction);
  }

  async getPaymentSummary(
    merchantId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    totalVolume: number;
    totalFees: number;
    netRevenue: number;
    count: number;
    byCurrency: Record<string, number>;
  }> {
    const db = getDb();

    const rows = await db('transactions as t')
      .join('payments as p', 'p.id', 't.payment_id')
      .where('p.merchant_id', merchantId)
      .where('t.type', TransactionType.PAYMENT)
      .where('t.status', PaymentStatus.COMPLETED)
      .whereBetween('t.created_at', [fromDate, toDate])
      .select(
        db.raw('SUM(t.amount) as total_volume'),
        db.raw('SUM(COALESCE(t.fee, 0)) as total_fees'),
        db.raw('SUM(COALESCE(t.net, t.amount)) as net_revenue'),
        db.raw('COUNT(*) as count'),
        't.currency',
      )
      .groupBy('t.currency');

    const byCurrency: Record<string, number> = {};
    let totalVolume = 0;
    let totalFees = 0;
    let netRevenue = 0;
    let count = 0;

    for (const row of rows) {
      byCurrency[row.currency] = Number(row.total_volume);
      totalVolume += Number(row.total_volume);
      totalFees += Number(row.total_fees);
      netRevenue += Number(row.net_revenue);
      count += Number(row.count);
    }

    return { totalVolume, totalFees, netRevenue, count, byCurrency };
  }

  private toTransaction(row: Record<string, any>): Transaction {
    return {
      id: row.id,
      paymentId: row.payment_id,
      type: row.type,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status,
      providerTransactionId: row.provider_transaction_id,
      fee: row.fee ? Number(row.fee) : undefined,
      net: row.net ? Number(row.net) : undefined,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
    };
  }
}
