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
  idempotencyMiddleware,
  validate(createPaymentSchema),
  createPayment,
);

/**
 * GET /payments
 * List payments with filters and pagination.
 */
router.get(
  '/',
  validate(paymentFiltersSchema, 'query'),
  listPayments,
);

/**
 * GET /payments/:paymentId
 * Retrieve a single payment by ID.
 */
router.get('/:paymentId', getPayment);

/**
 * POST /payments/:paymentId/capture
 * Capture an authorized (uncaptured) payment.
 */
router.post(
  '/:paymentId/capture',
  authorize('admin', 'merchant'),
  validate(capturePaymentSchema),
  capturePayment,
);

/**
 * POST /payments/:paymentId/cancel
 * Cancel a pending or authorized payment.
 */
router.post(
  '/:paymentId/cancel',
  authorize('admin', 'merchant'),
  cancelPayment,
);

// ── Refunds ───────────────────────────────────────────────────────────────────

/**
 * POST /payments/:paymentId/refunds
 * Create a refund for a completed payment.
 */
router.post(
  '/:paymentId/refunds',
  authorize('admin', 'merchant'),
  idempotencyMiddleware,
  validate(createRefundSchema),
  createRefund,
);

/**
 * GET /payments/:paymentId/refunds
 * List all refunds for a payment.
 */
router.get('/:paymentId/refunds', listRefunds);

/**
 * GET /payments/:paymentId/refunds/:refundId
 * Get a specific refund.
 */
router.get('/:paymentId/refunds/:refundId', getRefund);

// ── Transactions ──────────────────────────────────────────────────────────────

/**
 * GET /payments/:paymentId/transactions
 * List all ledger transactions for a payment.
 */
router.get('/:paymentId/transactions', listTransactions);

// ── Analytics ─────────────────────────────────────────────────────────────────

/**
 * GET /payments/summary/:merchantId
 * Get payment volume summary for a merchant.
 */
router.get(
  '/summary/:merchantId',
  authorize('admin', 'merchant'),
  getPaymentSummary,
);

export default router;
