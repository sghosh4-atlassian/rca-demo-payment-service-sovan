import { PaymentRetryService } from '../../services/PaymentRetryService';
import { getDb } from '../../database/connection';
import { ConflictError, PaymentError } from '../../utils/errors';

jest.mock('../../database/connection');
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

// Backing store for the count value returned when the chain is awaited directly
let mockCountValue = '0';

const mockDb = {
  where: jest.fn().mockReturnThis(),
  count: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insert: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  // Makes `await db('table').where(...).count(...)` resolve to [{ count }]
  then: (resolve: (v: any) => any, reject?: (e: any) => any) =>
    Promise.resolve([{ count: mockCountValue }]).then(resolve, reject),
};

describe('PaymentRetryService', () => {
  let service: PaymentRetryService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCountValue = '0'; // reset count before each test
    (getDb as jest.Mock).mockReturnValue(
      Object.assign(jest.fn().mockReturnValue(mockDb), mockDb),
    );
    service = new PaymentRetryService();
  });

  describe('scheduleRetry()', () => {
    it('schedules first retry with no delay for a retryable failure code', async () => {
      mockCountValue = '0';

      const result = await service.scheduleRetry('pay_1', 'card_declined', 'Card was declined');

      expect(result.attemptNumber).toBe(1);
      // First attempt → immediate (scheduledAt ≈ now)
      expect(result.scheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_id: 'pay_1',
          attempt_number: 1,
          status: 'pending',
          failure_code: 'card_declined',
        }),
      );
    });

    it('schedules second retry with 60s delay (exponential backoff)', async () => {
      mockCountValue = '1';

      const before = Date.now();
      const result = await service.scheduleRetry('pay_1', 'processing_error', 'Timeout');
      const after = Date.now();

      expect(result.attemptNumber).toBe(2);
      // Should be scheduled ~60 seconds from now
      const delayMs = result.scheduledAt.getTime() - before;
      expect(delayMs).toBeGreaterThanOrEqual(59_000);
      expect(delayMs).toBeLessThanOrEqual(61_000 + (after - before));
    });

    it('throws PaymentError for a permanent failure code', async () => {
      await expect(
        service.scheduleRetry('pay_1', 'fraudulent', 'Fraud detected'),
      ).rejects.toThrow(PaymentError);

      await expect(
        service.scheduleRetry('pay_1', 'stolen_card', 'Stolen card'),
      ).rejects.toThrow(PaymentError);
    });

    it('throws PaymentError for an unknown non-retryable code', async () => {
      await expect(
        service.scheduleRetry('pay_1', 'some_random_code', 'Unknown'),
      ).rejects.toThrow(PaymentError);
    });

    it('throws ConflictError when max retry attempts reached', async () => {
      mockCountValue = '3'; // already at max (3)

      await expect(
        service.scheduleRetry('pay_1', 'card_declined', 'Declined'),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('getCooldownRemaining()', () => {
    it('returns 0 when no prior attempts exist', async () => {
      mockDb.first.mockResolvedValue(null);
      const remaining = await service.getCooldownRemaining('pay_1');
      expect(remaining).toBe(0);
    });

    it('returns 0 when scheduled time has already passed', async () => {
      const pastDate = new Date(Date.now() - 10_000); // 10s ago
      mockDb.first.mockResolvedValue({ scheduled_at: pastDate.toISOString() });
      const remaining = await service.getCooldownRemaining('pay_1');
      expect(remaining).toBe(0);
    });

    it('returns seconds remaining when still in cool-down', async () => {
      const futureDate = new Date(Date.now() + 30_000); // 30s from now
      mockDb.first.mockResolvedValue({ scheduled_at: futureDate.toISOString() });
      const remaining = await service.getCooldownRemaining('pay_1');
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(30);
    });
  });

  describe('isExhausted()', () => {
    it('returns false when attempts < maxAttempts', async () => {
      mockCountValue = '2';
      expect(await service.isExhausted('pay_1')).toBe(false);
    });

    it('returns true when attempts === maxAttempts', async () => {
      mockCountValue = '3';
      expect(await service.isExhausted('pay_1')).toBe(true);
    });
  });

  describe('markRetrySucceeded()', () => {
    it('updates the attempt record to succeeded', async () => {
      await service.markRetrySucceeded('pay_1', 1);
      expect(mockDb.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded' }),
      );
    });
  });
});
