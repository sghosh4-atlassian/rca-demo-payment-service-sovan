import { Router } from 'express';
import { handleStripeWebhook } from '../controllers/WebhookController';

const router = Router();

/**
 * POST /webhooks/stripe
 * Stripe sends signed events here.
 * Raw body parsing is applied at the app level for this route only.
 */
router.post('/stripe', handleStripeWebhook);

export default router;
