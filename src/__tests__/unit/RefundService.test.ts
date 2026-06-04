import { RefundService } from '../../services/RefundService';
import { StripeProvider } from '../../providers/StripeProvider';
import { TransactionService } from '../../services/TransactionService';
import { WebhookService } from '../../services/WebhookService';
import { getDb } from '../../database/connection';
import { PaymentStatus, RefundStatus } from '../../types';
import { RefundError, NotFoundError, ConflictError } from '../../utils/errors';

jest.mock('../../database/connection');
jest.mock('../../providers/StripeProvider');
jest.mock('../../providers/PayPalProvider');
jest.mock('../../services/TransactionService');
jest.mock('../../services/WebhookService');

const mockDb = {
  where: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insert: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  returning: jest.fn(),
  increment: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
};

const mockPaymentRow = {
  id: 'pay_123',
  merchant_id: 'merch_1',
  amount: 5000,
  currency: 'USD',
  status: PaymentStatus.COMPLETED,
  provider: 'stripe',
  provider_payment_id: 'pi_stripe_abc',
  refunded_amount: 0,
};

const mockRefundRow = {
  id: 'ref_1',
  payment_id: 'pay_123',
  merchant_id: 'merch_1',
  amount: 2000,
  currency: 'USD',
  status: RefundStatus.COMPLETED,
  reason: 'customer_request',
  provider_refund_id: 're_stripe_xyz',
  initiated_by: 'user_1',
  metadata: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('RefundService', () => {
  let service: RefundService;
  let mockStripe: jest.Mocked<StripeProvider>;
  let mockWebhooks: jest.Mocked<WebhookService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (getDb as jest.Mock).mockReturnValue(
      Object.assign(jest.fn().mockReturnValue(mockDb), mockDb),
    );
    service = new RefundService();
    mockStripe = (StripeProvider as jest.MockedClass<typeof StripeProvider>).mock.instances[0] as jest.Mocked<StripeProvider>;
    mockWebhooks = (WebhookService as jest.MockedClass<typeof WebhookService>).mock.instances[0] as jest.Mocked<WebhookService>;
    mockWebhooks.dispatch.mockResolvedValue(undefined);
  });

  describe('createRefund', () => {
    it('creates a partial refund successfully', async () => {
      mockDb.first.mockResolvedValueOnce(mockPaymentRow);
      mockDb.returning
        .mockResolvedValueOnce([{ ...mockRefundRow, status: RefundStatus.PENDING }])
        .mockResolvedValueOnce([{ ...mockRefundRow, status: RefundStatus.COMPLETED }]);
      mockStripe.createRefund = jest.fn().mockResolvedValue({ providerRefundId: 're_stripe_xyz' });

      const refund = await service.createRefund({
        paymentId: 'pay_123',
        amount: 2000,
        reason: 'customer_request',
        initiatedBy: 'user_1',
      });

      expect(refund.status).toBe(RefundStatus.COMPLETED);
      expect(refund.amount).toBe(2000);
      expect(mockStripe.createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 2000 }),
      );
      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'merch_1',
        'refund.completed',
        expect.any(Object),
      );
    });

    it('throws NotFoundError when payment does not exist', async () => {
      mockDb.first.mockResolvedValueOnce(undefined);

      await expect(
        service.createRefund({ paymentId: 'nonexistent', initiatedBy: 'user_1' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError when payment is not completed', async () => {
      mockDb.first.mockResolvedValueOnce({
        ...mockPaymentRow,
        status: PaymentStatus.PENDING,
      });

      await expect(
        service.createRefund({ paymentId: 'pay_123', initiatedBy: 'user_1' }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws RefundError when refund amount exceeds available balance', async () => {
      mockDb.first.mockResolvedValueOnce({
        ...mockPaymentRow,
        refunded_amount: 4000,
      });

      await expect(
        service.createRefund({ paymentId: 'pay_123', amount: 2000, initiatedBy: 'user_1' }),
      ).rejects.toThrow(RefundError);
    });

    it('marks refund as failed and dispatches webhook on provider error', async () => {
      mockDb.first.mockResolvedValueOnce(mockPaymentRow);
      mockDb.returning.mockResolvedValueOnce([{ ...mockRefundRow, status: RefundStatus.PENDING }]);
      mockStripe.createRefund = jest.fn().mockRejectedValue(new Error('Provider error'));

      await expect(
        service.createRefund({ paymentId: 'pay_123', amount: 1000, initiatedBy: 'user_1' }),
      ).rejects.toThrow(RefundError);

      expect(mockWebhooks.dispatch).toHaveBeenCalledWith(
        'merch_1',
        'refund.failed',
        expect.any(Object),
      );
    });
  });

  describe('getRefundById', () => {
    it('returns a refund by id', async () => {
      mockDb.first.mockResolvedValueOnce(mockRefundRow);
      const refund = await service.getRefundById('ref_1');
      expect(refund.id).toBe('ref_1');
    });

    it('throws NotFoundError for unknown refund', async () => {
      mockDb.first.mockResolvedValueOnce(undefined);
      await expect(service.getRefundById('bad_id')).rejects.toThrow(NotFoundError);
    });
  });
});
