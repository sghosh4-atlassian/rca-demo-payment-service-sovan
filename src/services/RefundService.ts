import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import {
  Refund,
  CreateRefundDTO,
  RefundStatus,
  PaymentStatus,
  TransactionType,
} from '../types';
import { NotFoundError, RefundError, ConflictError } from '../utils/errors';
import { StripeProvider } from '../providers/StripeProvider';
import { PayPalProvider } from '../providers/PayPalProvider';
import { TransactionService } from './TransactionService';
import { WebhookService } from './WebhookService';
import logger, { logPaymentEvent } from '../utils/logger';

export class RefundService {
  private stripeProvider: StripeProvider;
  private paypalProvider: PayPalProvider;
  private transactionService: TransactionService;
  private webhookService: WebhookService;

  constructor() {
    this.stripeProvider = new StripeProvider();
    this.paypalProvider = new PayPalProvider();
    this.transactionService = new TransactionService();
    this.webhookService = new WebhookService();
  }

  async createRefund(dto: CreateRefundDTO): Promise<Refund> {
    const db = getDb();

    // 1. Fetch and validate payment
    const payment = await db('payments').where({ id: dto.paymentId }).first();
    if (!payment) throw new NotFoundError('Payment', dto.paymentId);

    if (payment.status !== PaymentStatus.COMPLETED) {
      throw new ConflictError(`Cannot refund payment with status: ${payment.status}`);
    }

    const refundAmount = dto.amount ?? Number(payment.amount);
    const alreadyRefunded = Number(payment.refunded_amount);

    if (refundAmount <= 0) {
      throw new RefundError('Refund amount must be greater than 0');
    }

    if (alreadyRefunded + refundAmount > Number(payment.amount)) {
      throw new RefundError(
        `Refund amount ${refundAmount} exceeds available balance ${Number(payment.amount) - alreadyRefunded}`,
      );
    }

    // 2. Create refund record
    const refundId = uuidv4();
    const [refund] = await db('refunds')
      .insert({
        id: refundId,
        payment_id: dto.paymentId,
        merchant_id: payment.merchant_id,
        amount: refundAmount,
        currency: payment.currency,
        status: RefundStatus.PENDING,
        reason: dto.reason ?? null,
        initiated_by: dto.initiatedBy,
        metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
      })
      .returning('*');

    logPaymentEvent('refund.created', { refundId, paymentId: dto.paymentId, amount: refundAmount });

    try {
      // 3. Process refund with provider
      const provider = this.resolveProvider(payment.provider);
      const providerRefund = await provider.createRefund({
        providerPaymentId: payment.provider_payment_id,
        amount: refundAmount,
        reason: dto.reason,
      });

      // 4. Update refund record
      const [updatedRefund] = await db('refunds')
        .where({ id: refundId })
        .update({
          status: RefundStatus.COMPLETED,
          provider_refund_id: providerRefund.providerRefundId,
          updated_at: new Date(),
        })
        .returning('*');

      // 5. Update payment refunded_amount & status
      const newRefundedAmount = alreadyRefunded + refundAmount;
      const newPaymentStatus =
        newRefundedAmount >= Number(payment.amount)
          ? PaymentStatus.REFUNDED
          : PaymentStatus.PARTIALLY_REFUNDED;

      await db('payments').where({ id: dto.paymentId }).update({
        refunded_amount: newRefundedAmount,
        status: newPaymentStatus,
        updated_at: new Date(),
      });

      // 6. Record transaction
      await this.transactionService.createTransaction({
        paymentId: dto.paymentId,
        type: TransactionType.REFUND,
        amount: refundAmount,
        currency: payment.currency,
        status: PaymentStatus.COMPLETED,
        providerTransactionId: providerRefund.providerRefundId,
      });

      // 7. Fire webhook
      await this.webhookService.dispatch(payment.merchant_id, 'refund.completed', {
        refundId,
        paymentId: dto.paymentId,
        amount: refundAmount,
      });

      logPaymentEvent('refund.completed', { refundId, amount: refundAmount });
      return this.toRefund(updatedRefund);
    } catch (err: any) {
      await db('refunds')
        .where({ id: refundId })
        .update({ status: RefundStatus.FAILED, updated_at: new Date() });

      await this.webhookService.dispatch(payment.merchant_id, 'refund.failed', {
        refundId,
        paymentId: dto.paymentId,
        error: err.message,
      });

      logger.error('Refund failed', { refundId, error: err.message });
      throw new RefundError(err.message);
    }
  }

  async getRefundById(id: string): Promise<Refund> {
    const db = getDb();
    const row = await db('refunds').where({ id }).first();
    if (!row) throw new NotFoundError('Refund', id);
    return this.toRefund(row);
  }

  async listRefundsByPayment(paymentId: string): Promise<Refund[]> {
    const db = getDb();
    const rows = await db('refunds')
      .where({ payment_id: paymentId })
      .orderBy('created_at', 'desc');
    return rows.map(this.toRefund);
  }

  private resolveProvider(provider: string) {
    switch (provider) {
      case 'stripe': return this.stripeProvider;
      case 'paypal': return this.paypalProvider;
      default: throw new RefundError(`Unsupported provider: ${provider}`);
    }
  }

  private toRefund(row: Record<string, any>): Refund {
    return {
      id: row.id,
      paymentId: row.payment_id,
      merchantId: row.merchant_id,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status,
      reason: row.reason,
      providerRefundId: row.provider_refund_id,
      initiatedBy: row.initiated_by,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
