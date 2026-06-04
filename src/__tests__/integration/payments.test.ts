import request from 'supertest';
import { createApp } from '../../app';
import { PaymentService } from '../../services/PaymentService';
import { Currency, PaymentMethod, PaymentProvider, PaymentStatus } from '../../types';
import jwt from 'jsonwebtoken';
import { config } from '../../config';

jest.mock('../../services/PaymentService');
jest.mock('../../database/connection', () => ({ getDb: jest.fn(), connectDb: jest.fn() }));
jest.mock('../../services/CacheService', () => ({
  CacheService: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  })),
}));

function makeToken(role: 'admin' | 'merchant' | 'readonly' = 'merchant', merchantId = 'merch_1') {
  return jwt.sign({ sub: 'user_1', merchantId, role }, config.jwt.secret, { expiresIn: '1h' });
}

const mockPayment = {
  id: 'pay_abc',
  merchantId: 'merch_1',
  customerId: 'cust_1',
  orderId: 'order_1',
  amount: 1000,
  currency: Currency.USD,
  status: PaymentStatus.COMPLETED,
  method: PaymentMethod.CARD,
  provider: PaymentProvider.STRIPE,
  idempotencyKey: 'key_abc',
  refundedAmount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('Payments API', () => {
  let app: ReturnType<typeof createApp>;
  let mockPaymentService: jest.Mocked<PaymentService>;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
    mockPaymentService = (PaymentService as jest.MockedClass<typeof PaymentService>)
      .mock.instances[0] as jest.Mocked<PaymentService>;
  });

  // ── POST /api/v1/payments ─────────────────────────────────────────────────

  describe('POST /api/v1/payments', () => {
    const validBody = {
      merchantId: 'merch_1',
      customerId: 'cust_1',
      orderId: 'order_1',
      amount: 1000,
      currency: 'USD',
      method: 'card',
      provider: 'stripe',
      idempotencyKey: 'unique-key-xyz-123',
    };

    it('creates a payment and returns 201', async () => {
      mockPaymentService.createPayment.mockResolvedValue(mockPayment as any);

      const res = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('pay_abc');
    });

    it('returns 401 when no Authorization header provided', async () => {
      const res = await request(app).post('/api/v1/payments').send(validBody);
      expect(res.status).toBe(401);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ amount: 1000 }); // missing required fields

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when amount is zero or negative', async () => {
      const res = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ ...validBody, amount: 0 });

      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/v1/payments/:paymentId ───────────────────────────────────────

  describe('GET /api/v1/payments/:paymentId', () => {
    it('returns a payment by id', async () => {
      mockPaymentService.getPaymentById.mockResolvedValue(mockPayment as any);

      const res = await request(app)
        .get('/api/v1/payments/pay_abc')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('pay_abc');
    });

    it('returns 404 for non-existent payment', async () => {
      const { NotFoundError } = await import('../../utils/errors');
      mockPaymentService.getPaymentById.mockRejectedValue(new NotFoundError('Payment', 'bad_id'));

      const res = await request(app)
        .get('/api/v1/payments/bad_id')
        .set('Authorization', `Bearer ${makeToken()}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ── POST /api/v1/payments/:paymentId/cancel ───────────────────────────────

  describe('POST /api/v1/payments/:paymentId/cancel', () => {
    it('cancels a payment', async () => {
      mockPaymentService.cancelPayment.mockResolvedValue({
        ...mockPayment,
        status: PaymentStatus.CANCELLED,
      } as any);

      const res = await request(app)
        .post('/api/v1/payments/pay_abc/cancel')
        .set('Authorization', `Bearer ${makeToken('merchant')}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(PaymentStatus.CANCELLED);
    });

    it('returns 403 when readonly role tries to cancel', async () => {
      const res = await request(app)
        .post('/api/v1/payments/pay_abc/cancel')
        .set('Authorization', `Bearer ${makeToken('readonly')}`);

      expect(res.status).toBe(403);
    });
  });

  // ── GET /health ───────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with service info', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });
});
