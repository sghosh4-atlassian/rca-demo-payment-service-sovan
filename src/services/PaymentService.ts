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
} from '../types';
import { NotFoundError, PaymentError, IdempotencyError, ConflictError } from '../utils/errors';
import { StripeProvider } from '../providers/StripeProvider';
import { PayPalProvider } from '../providers/PayPalProvider';
import { TransactionService } from './TransactionService';
import { WebhookService } from './WebhookService';
import { CacheService } from './CacheService';
import logger, { logPaymentEvent } from '../utils/logger';

export class PaymentService {
  private stripeProvider: StripeProvider;
  private paypalProvider: PayPalProvider;
  private transactionService: TransactionService;
  private webhookService: WebhookService;
  private cacheService: CacheService;

  constructor() {
    this.stripeProvider = new StripeProvider();
    this.paypalProvider = new PayPalProvider();
    this.transactionService = new TransactionService();
    this.webhookService = new WebhookService();
    this.cacheService = new CacheService();
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createPayment(dto: CreatePaymentDTO): Promise<Payment> {
    // 1. Idempotency check
    const existing = await this.getByIdempotencyKey(dto.idempotencyKey);
    if (existing) {
      logger.info('Returning cached idempotent payment', { key: dto.idempotencyKey });
      return existing;
    }

    const db = getDb();
    const paymentId = uuidv4();

    // 2. Persist initial record
    const [payment] = await db('payments')
      .insert({
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
      })
      .returning('*');

    logPaymentEvent('payment.created', { paymentId, amount: dto.amount, currency: dto.currency });

    try {
      // 3. Process with provider
      const provider = this.resolveProvider(dto.provider ?? 'stripe');
      const providerResult = await provider.createPayment({
        amount: dto.amount,
        currency: dto.currency,
        paymentMethodId: dto.paymentMethodId,
        customerId: dto.customerId,
        description: dto.description,
        metadata: { paymentId, orderId: dto.orderId, merchantId: dto.merchantId },
        capture: dto.capture ?? true,
      });

      // 4. Update with provider result
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

      // 5. Record transaction
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

      // 6. Cache idempotency result
      await this.storeIdempotencyResult(dto.idempotencyKey, paymentId);

      // 7. Fire webhook
      await this.webhookService.dispatch(dto.merchantId, 'payment.completed', {
        paymentId,
        status,
        amount: dto.amount,
        currency: dto.currency,
      });

      logPaymentEvent('payment.completed', { paymentId, status });
      return this.toPayment(updated);
    } catch (err: any) {
      // Mark as failed
      await db('payments')
        .where({ id: paymentId })
        .update({
          status: PaymentStatus.FAILED,
          failure_code: err.errorCode ?? 'UNKNOWN',
          failure_message: err.message,
          updated_at: new Date(),
        });

      logPaymentEvent('payment.failed', { paymentId, error: err.message });
      await this.webhookService.dispatch(dto.merchantId, 'payment.failed', { paymentId });
      throw new PaymentError(err.message, err.errorCode);
    }
  }

  // ── Capture ───────────────────────────────────────────────────────────────

  async capturePayment(dto: CapturePaymentDTO): Promise<Payment> {
    const payment = await this.getPaymentById(dto.paymentId);

    if (payment.status !== PaymentStatus.PROCESSING) {
      throw new ConflictError(`Payment ${dto.paymentId} is not in a capturable state (status: ${payment.status})`);
    }

    const provider = this.resolveProvider(payment.provider);
    await provider.capturePayment(payment.providerPaymentId!, dto.amount);

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
