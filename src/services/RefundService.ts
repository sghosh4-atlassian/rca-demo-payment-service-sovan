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
    const payment = (await db('payments').where({ id: dto.paymentId }).first()) as Record<string, unknown> | undefined;
    if (!payment) {
      throw new NotFoundError('Payment', dto.paymentId);
    }

    const paymentStatus = payment.status as PaymentStatus;
    if (paymentStatus !== PaymentStatus.COMPLETED) {
      throw new ConflictError(`Cannot refund payment with status: ${paymentStatus}`);
    }

    const refundAmount = dto.amount ?? Number(payment.amount);
    const alreadyRefunded = Number(payment.refunded_amount);

    if (refundAmount <= 0) {
      throw new RefundError('Refund amount must be greater than 0');
    }

    const totalAmount = Number(payment.amount);
    if (alreadyRefunded + refundAmount > totalAmount) {
      throw new RefundError(
        `Refund amount ${refundAmount} exceeds available balance ${totalAmount - alreadyRefunded}`,
      );
    }

    // 2. Create refund record
    const refundId = uuidv4();
    await db('refunds')
      .insert({
        id: refundId,
        payment_id: dto.paymentId,
        merchant_id: payment.merchant_id as string,
        amount: refundAmount,
        currency: payment.currency as string,
        status: RefundStatus.PENDING,
        reason: dto.reason ?? null,
        initiated_by: dto.initiatedBy,
        metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
      })
      .returning('*');

    logPaymentEvent('refund.created', { refundId, paymentId: dto.paymentId, amount: refundAmount });

    try {
      // 3. Process refund with provider
      const provider = this.resolveProvider(payment.provider as string);
      const providerRefund = await provider.createRefund({
        providerPaymentId: payment.provider_payment_id as string,
        amount: refundAmount,
        reason: dto.reason,
      });

      // 4. Update refund record
      const [updatedRefund] = (await db('refunds')
        .where({ id: refundId })
        .update({
          status: RefundStatus.COMPLETED,
          provider_refund_id: providerRefund.providerRefundId,
          updated_at: new Date(),
        })
        .returning('*')) as Record<string, unknown>[];

      // 5. Update payment refunded_amount & status
      const newRefundedAmount = alreadyRefunded + refundAmount;
      const newPaymentStatus =
        newRefundedAmount >= totalAmount
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
        currency: payment.currency as string,
        status: PaymentStatus.COMPLETED,
        providerTransactionId: providerRefund.providerRefundId,
      });

      // 7. Fire webhook
      await this.webhookService.dispatch(payment.merchant_id as string, 'refund.completed', {
        refundId,
        paymentId: dto.paymentId,
        amount: refundAmount,
      });

      logPaymentEvent('refund.completed', { refundId, amount: refundAmount });
      return this.toRefund(updatedRefund);
    } catch (err: unknown) {
      await db('refunds')
        .where({ id: refundId })
        .update({ status: RefundStatus.FAILED, updated_at: new Date() });

      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.webhookService.dispatch(payment.merchant_id as string, 'refund.failed', {
        refundId,
        paymentId: dto.paymentId,
        error: errorMessage,
      });

      logger.error('Refund failed', { refundId, error: errorMessage });
      throw new RefundError(errorMessage);
    }
  }

  async getRefundById(id: string): Promise<Refund> {
    const db = getDb();
    const row = (await db('refunds').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!row) {
      throw new NotFoundError('Refund', id);
    }
    return this.toRefund(row);
  }

  async listRefundsByPayment(paymentId: string): Promise<Refund[]> {
    const db = getDb();
    const rows = (await db('refunds')
      .where({ payment_id: paymentId })
      .orderBy('created_at', 'desc')) as Record<string, unknown>[];
    return rows.map((r) => this.toRefund(r));
  }

  private resolveProvider(provider: string) {
    switch (provider) {
      case 'stripe': return this.stripeProvider;
      case 'paypal': return this.paypalProvider;
      default: throw new RefundError(`Unsupported provider: ${provider}`);
    }
  }

  private toRefund(row: Record<string, unknown>): Refund {
    return {
      id: row.id as string,
      paymentId: row.payment_id as string,
      merchantId: row.merchant_id as string,
      amount: Number(row.amount),
      currency: row.currency as string,
      status: row.status as string,
      reason: row.reason as string | null,
      providerRefundId: row.provider_refund_id as string | null,
      initiatedBy: row.initiated_by as string,
      metadata: row.metadata as string | null,
      createdAt: new Date(row.created_at as string | number | Date),
      updatedAt: new Date(row.updated_at as string | number | Date),
    };
  }
}
