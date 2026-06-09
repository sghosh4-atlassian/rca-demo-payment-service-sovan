import { FraudRiskService, FraudRiskLevel } from '../../services/FraudRiskService';
import { CacheService } from '../../services/CacheService';
import { getDb } from '../../database/connection';
import { Currency, PaymentMethod, PaymentProvider } from '../../types';

jest.mock('../../database/connection');
jest.mock('../../services/CacheService');

const mockDb = {
  where: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  avg: jest.fn().mockReturnThis(),
  count: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insert: jest.fn().mockResolvedValue(undefined),
};

const baseDTO = {
  merchantId: 'merch_1',
  customerId: 'cust_1',
  orderId: 'order_1',
  amount: 1000,
  currency: Currency.USD,
  method: PaymentMethod.CARD,
  provider: PaymentProvider.STRIPE,
  idempotencyKey: 'key_1',
  capture: true,
  returnUrl: 'https://example.com/payment/return',
  cancelUrl: 'https://example.com/payment/cancel',
};

describe('FraudRiskService', () => {
  let service: FraudRiskService;
  let mockCache: jest.Mocked<CacheService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (getDb as jest.Mock).mockReturnValue(
      Object.assign(jest.fn().mockReturnValue(mockDb), mockDb),
    );
    service = new FraudRiskService();
    mockCache = (CacheService as jest.MockedClass<typeof CacheService>).mock
      .instances[0] as jest.Mocked<CacheService>;
  });

  describe('assess()', () => {
    it('returns LOW risk for a clean, known customer with normal amount', async () => {
      // No velocity hits, known customer, normal amount
      mockCache.increment.mockResolvedValue(1);        // velocity count = 1 (below threshold 5)
      mockCache.get.mockResolvedValue(null);            // no failure velocity, unknown cache
      mockCache.set.mockResolvedValue(undefined);

      // avg amount query: customer has history, amount is within 3×
      mockDb.first.mockResolvedValue({ avg_amount: 1000, count: 5 });

      const assessment = await service.assess(baseDTO, 'pay_test_1');

      expect(assessment.score).toBeLessThan(50);
      expect(assessment.riskLevel).toBe(FraudRiskLevel.LOW);
      expect(assessment.blocked).toBe(false);
      expect(assessment.requiresReview).toBe(false);
    });

    it('flags MEDIUM risk when customer is first-time', async () => {
      mockCache.increment.mockResolvedValue(1);
      mockCache.get.mockResolvedValue(null);
      mockCache.set.mockResolvedValue(undefined);

      // No prior successful payments → first-time (+10)
      mockDb.first.mockResolvedValue({ avg_amount: 0, count: 0 });

      const assessment = await service.assess(baseDTO, 'pay_test_2');

      const firstTimeSignal = assessment.signals.find((s) => s.code === 'FIRST_TIME_CUSTOMER');
      expect(firstTimeSignal).toBeDefined();
      expect(firstTimeSignal?.weight).toBe(10);
    });

    it('returns HIGH risk and blocks when velocity exceeds threshold', async () => {
      // Payment velocity = 8 (exceeds threshold of 5 → +30)
      // Failure velocity = 5 (exceeds threshold of 3 → +25)
      // Amount anomaly: avg=200, payment=1000 → 5× average, count=5 → +20
      // Total: 30 + 25 + 20 = 75 → blocked
      mockCache.increment.mockResolvedValue(8);
      mockCache.get.mockResolvedValue(5);   // failure count
      mockCache.set.mockResolvedValue(undefined);

      // avg_amount=200, count=5 → payment of 1000 is 5× average → AMOUNT_ANOMALY (+20)
      mockDb.first.mockResolvedValue({ avg_amount: '200', count: '5' });

      const assessment = await service.assess(baseDTO, 'pay_test_3');

      expect(assessment.score).toBeGreaterThanOrEqual(75);
      expect(assessment.riskLevel).toBe(FraudRiskLevel.HIGH);
      expect(assessment.blocked).toBe(true);

      const velSignal = assessment.signals.find((s) => s.code === 'HIGH_PAYMENT_VELOCITY');
      expect(velSignal).toBeDefined();
    });

    it('flags AMOUNT_ANOMALY signal when payment is >3× customer average', async () => {
      mockCache.increment.mockResolvedValue(1);
      mockCache.get.mockResolvedValue(null);
      mockCache.set.mockResolvedValue(undefined);

      // Customer avg = 500, payment amount = 2000 → 4× average → anomaly (+20)
      mockDb.first.mockResolvedValue({ avg_amount: '500', count: '5' });

      const dto = { ...baseDTO, amount: 2000 };
      const assessment = await service.assess(dto, 'pay_test_4');

      const anomalySignal = assessment.signals.find((s) => s.code === 'AMOUNT_ANOMALY');
      expect(anomalySignal).toBeDefined();
      expect(anomalySignal?.weight).toBe(20);
    });

    it('does NOT flag AMOUNT_ANOMALY when customer has fewer than 3 transactions', async () => {
      mockCache.increment.mockResolvedValue(1);
      mockCache.get.mockResolvedValue(null);
      mockCache.set.mockResolvedValue(undefined);

      // Only 2 prior transactions → not enough history to flag
      mockDb.first.mockResolvedValue({ avg_amount: '500', count: '2' });

      const dto = { ...baseDTO, amount: 9999 };
      const assessment = await service.assess(dto, 'pay_test_5');

      const anomalySignal = assessment.signals.find((s) => s.code === 'AMOUNT_ANOMALY');
      expect(anomalySignal).toBeUndefined();
    });

    it('score is clamped to 100 even when all signals fire', async () => {
      mockCache.increment.mockResolvedValue(99); // +30 velocity
      mockCache.get.mockResolvedValue(99);        // +25 failure velocity
      mockCache.set.mockResolvedValue(undefined);
      mockDb.first.mockResolvedValue({ avg_amount: '100', count: '10' }); // +20 anomaly (amount 1000 > 300)

      const assessment = await service.assess(baseDTO, 'pay_test_6');
      expect(assessment.score).toBeLessThanOrEqual(100);
    });
  });

  describe('recordFailure()', () => {
    it('increments the failure velocity counter with 1-hour TTL', async () => {
      mockCache.increment.mockResolvedValue(1);
      await service.recordFailure('cust_1');
      expect(mockCache.increment).toHaveBeenCalledWith('fraud:vel:fail:cust_1', 3600);
    });
  });
});
