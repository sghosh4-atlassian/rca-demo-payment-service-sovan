import { Router } from 'express';
import {
  createPayment,
  getPayment,
  listPayments,
  capturePayment,
  cancelPayment,
  createRefund,
  getRefund,
  listRefunds,
  listTransactions,
  getPaymentSummary,
} from '../controllers/PaymentController';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idempotencyMiddleware } from '../middleware/idempotency';
import {
  createPaymentSchema,
  capturePaymentSchema,
  createRefundSchema,
  paymentFiltersSchema,
} from '../middleware/validate';

const router = Router();

// All payment routes require authentication
router.use(authenticate);

// ── Payments ──────────────────────────────────────────────────────────────────

/**
 * POST /payments
 * Create a new payment. Supports idempotency via Idempotency-Key header.
 */
router.post(
  '/',
  (req, res, next) => { void idempotencyMiddleware(req, res, next); },
  validate(createPaymentSchema),
  (req, res, next) => { void createPayment(req, res, next); },
);

/**
 * GET /payments
 * List payments with filters and pagination.
 */
router.get(
  '/',
  validate(paymentFiltersSchema, 'query'),
  (req, res, next) => { void listPayments(req, res, next); },
);

/**
 * GET /payments/:paymentId
 * Retrieve a single payment by ID.
 */
router.get('/:paymentId', (req, res, next) => { void getPayment(req, res, next); });

/**
 * POST /payments/:paymentId/capture
 * Capture an authorized (uncaptured) payment.
 */
router.post(
  '/:paymentId/capture',
  authorize('admin', 'merchant'),
  validate(capturePaymentSchema),
  (req, res, next) => { void capturePayment(req, res, next); },
);

/**
 * POST /payments/:paymentId/cancel
 * Cancel a pending or authorized payment.
 */
router.post(
  '/:paymentId/cancel',
  authorize('admin', 'merchant'),
  (req, res, next) => { void cancelPayment(req, res, next); },
);

// ── Refunds ───────────────────────────────────────────────────────────────────

/**
 * POST /payments/:paymentId/refunds
 * Create a refund for a completed payment.
 */
router.post(
  '/:paymentId/refunds',
  authorize('admin', 'merchant'),
  (req, res, next) => { void idempotencyMiddleware(req, res, next); },
  validate(createRefundSchema),
  (req, res, next) => { void createRefund(req, res, next); },
);

/**
 * GET /payments/:paymentId/refunds
 * List all refunds for a payment.
 */
router.get('/:paymentId/refunds', (req, res, next) => { void listRefunds(req, res, next); });

/**
 * GET /payments/:paymentId/refunds/:refundId
 * Get a specific refund.
 */
router.get('/:paymentId/refunds/:refundId', (req, res, next) => { void getRefund(req, res, next); });

// ── Transactions ──────────────────────────────────────────────────────────────

/**
 * GET /payments/:paymentId/transactions
 * List all ledger transactions for a payment.
 */
router.get('/:paymentId/transactions', (req, res, next) => { void listTransactions(req, res, next); });

// ── Analytics ─────────────────────────────────────────────────────────────────

/**
 * GET /payments/summary/:merchantId
 * Get payment volume summary for a merchant.
 */
router.get(
  '/summary/:merchantId',
  authorize('admin', 'merchant'),
  (req, res, next) => { void getPaymentSummary(req, res, next); },
);

export default router;
