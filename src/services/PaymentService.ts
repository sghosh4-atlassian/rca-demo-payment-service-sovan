import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import {
  Payment,
  CreatePaymentDTO,
  CapturePaymentDTO,
  PaymentFilters,
  PaginatedResult,
  PaymentStatus,
  TransactionType,
  ServiceResult,
  PaymentWithRiskContext,
} from '../types';
import { NotFoundError, PaymentError, IdempotencyError, ConflictError } from '../utils/errors';
import { StripeProvider } from '../providers/StripeProvider';
import { PayPalProvider } from '../providers/PayPalProvider';
import { TransactionService } from './TransactionService';
import { WebhookService } from './WebhookService';
import { CacheService } from './CacheService';
import { FraudRiskService } from './FraudRiskService';
import { PaymentRetryService } from './PaymentRetryService';
import logger, { logPaymentEvent } from '../utils/logger';

export class PaymentService {
  private stripeProvider: StripeProvider;
  private paypalProvider: PayPalProvider;
  private transactionService: TransactionService;
  private webhookService: WebhookService;
  private cacheService: CacheService;
  private fraudRiskService: FraudRiskService;
  private retryService: PaymentRetryService;

  constructor() {
    this.stripeProvider = new StripeProvider();
    this.paypalProvider = new PayPalProvider();
    this.transactionService = new TransactionService();
    this.webhookService = new WebhookService();
    this.cacheService = new CacheService();
    this.fraudRiskService = new FraudRiskService();
    this.retryService = new PaymentRetryService();
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createPayment(dto: CreatePaymentDTO): Promise<Payment> {
    // 1. Idempotency check — return cached result immediately
    const existing = await this.getByIdempotencyKey(dto.idempotencyKey);
    if (existing) {
      logger.info('Returning cached idempotent payment', { key: dto.idempotencyKey });
      return existing;
    }

    const db = getDb();
    const paymentId = uuidv4();

    // 2. Persist initial PENDING record
    await db('payments').insert({
      id: paymentId,
      merchant_id: dto.merchantId,
      customer_id: dto.customerId,
      order_id: dto.orderId,
      amount: dto.amount,
      currency: dto.currency,
      status: PaymentStatus.PENDING,
      method: dto.method,
      provider: dto.provider ?? 'stripe',
      description: dto.description ?? null,
      metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
      idempotency_key: dto.idempotencyKey,
      refunded_amount: 0,
    });

    logPaymentEvent('payment.created', { paymentId, amount: dto.amount, currency: dto.currency });

    // 3. ── Fraud Risk Assessment ──────────────────────────────────────────
    //    Run before touching any payment provider. A HIGH-risk score blocks
    //    the payment immediately without incurring provider charges.
    const fraudAssessment = await this.fraudRiskService.assess(dto, paymentId);

    if (fraudAssessment.blocked) {
      await db('payments').where({ id: paymentId }).update({
        status: PaymentStatus.FAILED,
        failure_code: 'FRAUD_BLOCKED',
        failure_message: `Payment blocked by fraud risk engine (score: ${fraudAssessment.score}/100)`,
        updated_at: new Date(),
      });

      await this.webhookService.dispatch(dto.merchantId, 'payment.failed', {
        paymentId,
        reason: 'FRAUD_BLOCKED',
        score: fraudAssessment.score,
      });

      throw new PaymentError(
        `Payment blocked: fraud risk score ${fraudAssessment.score}/100 exceeds threshold`,
        'FRAUD_BLOCKED',
        { score: fraudAssessment.score, signals: fraudAssessment.signals },
      );
    }

    // Log review flag but continue processing
    if (fraudAssessment.requiresReview) {
      logger.warn('Payment flagged for fraud review — processing with caution', {
        paymentId,
        score: fraudAssessment.score,
      });
    }

    try {
      // 4. ── Provider Processing ────────────────────────────────────────────
      const provider = this.resolveProvider(dto.provider ?? 'stripe');
      const providerResult = await provider.createPayment({
        amount: dto.amount,
        currency: dto.currency,
        paymentMethodId: dto.paymentMethodId,
        customerId: dto.customerId,
        description: dto.description,
        metadata: { paymentId, orderId: dto.orderId, merchantId: dto.merchantId },
        capture: dto.capture ?? true,
        returnUrl: dto.returnUrl,
        cancelUrl: dto.cancelUrl,
      });

      // 5. Update with provider result
      const status = providerResult.captured
        ? PaymentStatus.COMPLETED
        : PaymentStatus.PROCESSING;

      const [updated] = await db('payments')
        .where({ id: paymentId })
        .update({
          status,
          provider_payment_id: providerResult.providerPaymentId,
          provider_customer_id: providerResult.providerCustomerId ?? null,
          captured_at: providerResult.captured ? new Date() : null,
          updated_at: new Date(),
        })
        .returning('*');

      // 6. Record ledger transaction
      await this.transactionService.createTransaction({
        paymentId,
        type: TransactionType.PAYMENT,
        amount: dto.amount,
        currency: dto.currency,
        status,
        providerTransactionId: providerResult.providerPaymentId,
        fee: providerResult.fee,
        net: providerResult.net,
      });

      // 7. Cache idempotency result
      await this.storeIdempotencyResult(dto.idempotencyKey, paymentId);

      // 8. Invalidate any stale cached payment entry
      await this.cacheService.del(`payment:${paymentId}`);

      // 9. Fire webhook
      await this.webhookService.dispatch(dto.merchantId, 'payment.completed', {
        paymentId,
        status,
        amount: dto.amount,
        currency: dto.currency,
        fraudScore: fraudAssessment.score,
        requiresReview: fraudAssessment.requiresReview,
      });

      logPaymentEvent('payment.completed', { paymentId, status, fraudScore: fraudAssessment.score });
      return this.toPayment(updated);

    } catch (err: any) {
      const failureCode: string = err.errorCode ?? 'UNKNOWN';
      const failureMessage: string = err.message;

      // Mark payment as failed
      await db('payments').where({ id: paymentId }).update({
        status: PaymentStatus.FAILED,
        failure_code: failureCode,
        failure_message: failureMessage,
        updated_at: new Date(),
      });

      logPaymentEvent('payment.failed', { paymentId, failureCode, error: failureMessage });

      // ── Retry Scheduling ────────────────────────────────────────────────
      //    Attempt to schedule a retry if the failure code allows it.
      //    Non-retryable failures (fraud, permanent declines) are skipped silently.
      try {
        const retrySchedule = await this.retryService.scheduleRetry(
          paymentId,
          failureCode,
          failureMessage,
        );
        logger.info('Payment retry scheduled', {
          paymentId,
          attemptNumber: retrySchedule.attemptNumber,
          scheduledAt: retrySchedule.scheduledAt.toISOString(),
        });
      } catch (retryErr: any) {
        // Non-retryable or exhausted — log and continue to failure path
        logger.info('Payment will not be retried', {
          paymentId,
          reason: retryErr.message,
        });
        // Record failure velocity for fraud scoring on future attempts
        await this.fraudRiskService.recordFailure(dto.customerId);
      }

      await this.webhookService.dispatch(dto.merchantId, 'payment.failed', { paymentId, failureCode });
      throw new PaymentError(failureMessage, failureCode);
    }
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  async capturePayment(dto: CapturePaymentDTO): Promise<Payment> {
    const payment = await this.getPaymentById(dto.paymentId);

    if (payment.status !== PaymentStatus.PROCESSING) {
      throw new ConflictError(`Payment ${dto.paymentId} is not in a capturable state (status: ${payment.status})`);
    }

    const provider = this.resolveProvider(payment.provider);
    await provider.capturePayment(payment.providerPaymentId!);

    const db = getDb();
    const [updated] = await db('payments')
      .where({ id: dto.paymentId })
      .update({
        status: PaymentStatus.COMPLETED,
        captured_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');

    await this.webhookService.dispatch(payment.merchantId, 'payment.completed', {
      paymentId: dto.paymentId,
    });

    return this.toPayment(updated);
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  async cancelPayment(paymentId: string): Promise<Payment> {
    const payment = await this.getPaymentById(paymentId);

    if (![PaymentStatus.PENDING, PaymentStatus.PROCESSING].includes(payment.status)) {
      throw new ConflictError(`Cannot cancel payment with status: ${payment.status}`);
    }

    const provider = this.resolveProvider(payment.provider);
    if (payment.providerPaymentId) {
      await provider.cancelPayment(payment.providerPaymentId);
    }

    const db = getDb();
    const [updated] = await db('payments')
      .where({ id: paymentId })
      .update({ status: PaymentStatus.CANCELLED, updated_at: new Date() })
      .returning('*');

    await this.webhookService.dispatch(payment.merchantId, 'payment.cancelled', { paymentId });
    return this.toPayment(updated);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getPaymentById(id: string): Promise<Payment> {
    // Try cache first
    const cached = await this.cacheService.get<Payment>(`payment:${id}`);
    if (cached) return cached;

    const db = getDb();
    const row = await db('payments').where({ id }).first();
    if (!row) throw new NotFoundError('Payment', id);

    const payment = this.toPayment(row);
    await this.cacheService.set(`payment:${id}`, payment, 300);
    return payment;
  }

  async listPayments(filters: PaymentFilters): Promise<PaginatedResult<Payment>> {
    const db = getDb();
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const offset = (page - 1) * limit;

    let query = db('payments');

    if (filters.merchantId) query = query.where('merchant_id', filters.merchantId);
    if (filters.customerId) query = query.where('customer_id', filters.customerId);
    if (filters.orderId) query = query.where('order_id', filters.orderId);
    if (filters.status) query = query.where('status', filters.status);
    if (filters.method) query = query.where('method', filters.method);
    if (filters.currency) query = query.where('currency', filters.currency);
    if (filters.fromDate) query = query.where('created_at', '>=', filters.fromDate);
    if (filters.toDate) query = query.where('created_at', '<=', filters.toDate);
    if (filters.minAmount) query = query.where('amount', '>=', filters.minAmount);
    if (filters.maxAmount) query = query.where('amount', '<=', filters.maxAmount);

    const [{ count }] = await query.clone().count('id as count');
    const total = parseInt(String(count), 10);

    const sortBy = filters.sortBy ?? 'created_at';
    const sortOrder = filters.sortOrder ?? 'desc';
    const rows = await query.orderBy(sortBy, sortOrder).limit(limit).offset(offset);

    return {
      data: rows.map(this.toPayment),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private resolveProvider(provider: string) {
    switch (provider) {
      case 'stripe': return this.stripeProvider;
      case 'paypal': return this.paypalProvider;
      default: throw new PaymentError(`Unsupported provider: ${provider}`);
    }
  }

  private async getByIdempotencyKey(key: string): Promise<Payment | null> {
    const db = getDb();
    const ikRow = await db('idempotency_keys').where({ key }).first();
    if (!ikRow?.payment_id) return null;
    return this.getPaymentById(ikRow.payment_id).catch(() => null);
  }

  private async storeIdempotencyResult(key: string, paymentId: string): Promise<void> {
    const db = getDb();
    const expiresAt = new Date(Date.now() + 86400 * 1000);
    await db('idempotency_keys')
      .insert({ key, payment_id: paymentId, expires_at: expiresAt })
      .onConflict('key')
      .ignore();
  }

  private toPayment(row: Record<string, any>): Payment {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      orderId: row.order_id,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status,
      method: row.method,
      provider: row.provider,
      providerPaymentId: row.provider_payment_id,
      providerCustomerId: row.provider_customer_id,
      description: row.description,
      metadata: row.metadata,
      idempotencyKey: row.idempotency_key,
      failureCode: row.failure_code,
      failureMessage: row.failure_message,
      capturedAt: row.captured_at ? new Date(row.captured_at) : undefined,
      refundedAmount: Number(row.refunded_amount),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
