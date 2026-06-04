import { PaymentService } from '../../services/PaymentService';
import { StripeProvider } from '../../providers/StripeProvider';
import { TransactionService } from '../../services/TransactionService';
import { WebhookService } from '../../services/WebhookService';
import { CacheService } from '../../services/CacheService';
import { getDb } from '../../database/connection';
import {
  Currency,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  TransactionType,
} from '../../types';
import { PaymentError, NotFoundError, ConflictError } from '../../utils/errors';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../database/connection');
jest.mock('../../providers/StripeProvider');
jest.mock('../../providers/PayPalProvider');
jest.mock('../../services/TransactionService');
jest.mock('../../services/WebhookService');
jest.mock('../../services/CacheService');

const mockDb = {
  where: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  returning: jest.fn(),
  count: jest.fn(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  clone: jest.fn().mockReturnThis(),
};

const mockPaymentRow = {
  id: 'pay_123',
  merchant_id: 'merch_1',
  customer_id: 'cust_1',
  order_id: 'order_1',
  amount: 1000,
  currency: 'USD',
  status: PaymentStatus.COMPLETED,
  method: 'card',
  provider: 'stripe',
  provider_payment_id: 'pi_stripe_123',
  provider_customer_id: null,
  description: 'Test payment',
  metadata: null,
  idempotency_key: 'idem_key_1',
  failure_code: null,
  failure_message: null,
  captured_at: new Date(),
  refunded_amount: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

const baseDTO = {
  merchantId: 'merch_1',
  customerId: 'cust_1',
  orderId: 'order_1',
  amount: 1000,
  currency: Currency.USD,
  method: PaymentMethod.CARD,
  provider: PaymentProvider.STRIPE,
  idempotencyKey: 'unique-idem-key-abc123',
  capture: true,
};

describe('PaymentService', () => {
  let service: PaymentService;
  let mockStripe: jest.Mocked<StripeProvider>;
  let mockTransactions: jest.Mocked<TransactionService>;
  let mockWebhooks: jest.Mocked<WebhookService>;
  let mockCache: jest.Mocked<CacheService>;

  beforeEach(() => {
    jest.clearAllMocks();

    (getDb as jest.Mock).mockReturnValue(
      Object.assign(jest.fn().mockReturnValue(mockDb), mockDb),
    );

    service = new PaymentService();
    mockStripe = (StripeProvider as jest.MockedClass<typeof StripeProvider>).mock.instances[0] as jest.Mocked<StripeProvider>;
    mockTransactions = (TransactionService as jest.MockedClass<typeof TransactionService>).mock.instances[0] as jest.Mocked<TransactionService>;
    mockWebhooks = (WebhookService as jest.MockedClass<typeof WebhookService>).mock.instances[0] as jest.Mocked<WebhookService>;
    mockCache = (CacheService as jest.MockedClass<typeof CacheService>).mock.instances[0] as jest.Mocked<CacheService>;

    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockWebhooks.dispatch.mockResolvedValue(undefined);
    mockTransactions.createTransaction.mockResolvedValue({} as any);
  });

  // ── createPayment ──────────────────────────────────────────────────────────

  describe('createPayment', () => {
    it('creates a payment and returns completed status on successful capture', async () => {
      mockDb.returning.mockResolvedValue([mockPaymentRow]);
      mockStripe.createPayment = jest.fn().mockResolvedValue({
        providerPaymentId: 'pi_stripe_123',
        captured: true,
        fee: 29,
        net: 971,
      });

      const payment = await service.createPayment(baseDTO);

      expect(payment.id).toBe('pay_123');
      expect(payment.status).toBe(PaymentStatus.COMPLETED);
      expect(mockStripe.createPayment).toHaveBeenCalledTimes(1);
      expect(mockTransactions.createTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ type: TransactionType.PAYMENT }),
      );
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'merch_1',
        'payment.completed',
        expect.any(Object),
      );
    });

    it('returns existing payment when idempotency key matches', async () => {
      const existingPayment = { id: 'pay_existing', status: PaymentStatus.COMPLETED } as any;
      // Simulate idempotency_keys table returning a hit
      mockDb.first.mockResolvedValueOnce({ key: baseDTO.idempotencyKey, payment_id: 'pay_existing' });
      mockCache.get.mockResolvedValueOnce(existingPayment);

      const payment = await service.createPayment(baseDTO);

      expect(payment.id).toBe('pay_existing');
      expect(mockStripe.createPayment).not.toHaveBeenCalled();
    });

    it('marks payment as failed and throws PaymentError when provider fails', async () => {
      mockDb.returning.mockResolvedValue([{ ...mockPaymentRow, status: PaymentStatus.PENDING }]);
      mockStripe.createPayment = jest.fn().mockRejectedValue(
        new Error('Card declined'),
      );

      await expect(service.createPayment(baseDTO)).rejects.toThrow(PaymentError);

      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'merch_1',
        'payment.failed',
        expect.any(Object),
      );
    });
  });

  // ── capturePayment ─────────────────────────────────────────────────────────

  describe('capturePayment', () => {
    it('captures a processing payment successfully', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue({ ...mockPaymentRow, status: PaymentStatus.PROCESSING });
      mockDb.returning.mockResolvedValue([{ ...mockPaymentRow, status: PaymentStatus.COMPLETED }]);
      mockStripe.capturePayment = jest.fn().mockResolvedValue(undefined);

      const payment = await service.capturePayment({ paymentId: 'pay_123' });

      expect(payment.status).toBe(PaymentStatus.COMPLETED);
      expect(mockStripe.capturePayment).toHaveBeenCalledWith('pi_stripe_123', undefined);
    });

    it('throws ConflictError when payment is not in PROCESSING state', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue({ ...mockPaymentRow, status: PaymentStatus.COMPLETED });

      await expect(
        service.capturePayment({ paymentId: 'pay_123' }),
      ).rejects.toThrow(ConflictError);
    });
  });

  // ── cancelPayment ──────────────────────────────────────────────────────────

  describe('cancelPayment', () => {
    it('cancels a pending payment', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue({ ...mockPaymentRow, status: PaymentStatus.PENDING });
      mockDb.returning.mockResolvedValue([{ ...mockPaymentRow, status: PaymentStatus.CANCELLED }]);
      mockStripe.cancelPayment = jest.fn().mockResolvedValue(undefined);

      const payment = await service.cancelPayment('pay_123');

      expect(payment.status).toBe(PaymentStatus.CANCELLED);
    });

    it('throws ConflictError when payment cannot be cancelled', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue({ ...mockPaymentRow, status: PaymentStatus.REFUNDED });

      await expect(service.cancelPayment('pay_123')).rejects.toThrow(ConflictError);
    });
  });

  // ── getPaymentById ─────────────────────────────────────────────────────────

  describe('getPaymentById', () => {
    it('returns payment from cache when available', async () => {
      const cachedPayment = { id: 'pay_123', status: PaymentStatus.COMPLETED } as any;
      mockCache.get.mockResolvedValue(cachedPayment);

      const payment = await service.getPaymentById('pay_123');

      expect(payment).toEqual(cachedPayment);
      expect(mockDb.first).not.toHaveBeenCalled();
    });

    it('fetches from DB on cache miss and populates cache', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue(mockPaymentRow);

      const payment = await service.getPaymentById('pay_123');

      expect(payment.id).toBe('pay_123');
      expect(mockCache.set).toHaveBeenCalledWith('payment:pay_123', expect.any(Object), 300);
    });

    it('throws NotFoundError when payment does not exist', async () => {
      mockCache.get.mockResolvedValue(null);
      mockDb.first.mockResolvedValue(undefined);

      await expect(service.getPaymentById('nonexistent')).rejects.toThrow(NotFoundError);
    });
  });
});
