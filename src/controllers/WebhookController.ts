import { Request, Response, NextFunction } from 'express';
import { StripeProvider } from '../providers/StripeProvider';
import { PaymentStatus } from '../types';
import { getDb } from '../database/connection';
import logger from '../utils/logger';

const stripeProvider = new StripeProvider();

/**
 * Handles incoming Stripe webhook events.
 * NOTE: This route must receive raw body (Buffer) — do not apply express.json() before it.
 */
export async function handleStripeWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  const signature = req.headers['stripe-signature'] as string;

  let event;
  try {
    event = stripeProvider.verifyWebhookSignature(req.body as Buffer, signature);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.warn('Stripe webhook signature verification failed', { error: errMsg });
    res.status(400).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: errMsg } });
    return;
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    const obj = event.data.object as Record<string, unknown>;
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(obj as { id: string });
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(obj as { id: string; last_payment_error?: { code?: string; message?: string } });
        break;
      case 'charge.dispute.created':
        await handleDisputeCreated(obj as { payment_intent: string });
        break;
      case 'charge.refunded':
        // Handled internally — log only
        logger.info('Stripe charge.refunded event received', { chargeId: String(obj.id) });
        break;
      default:
        logger.debug(`Unhandled Stripe event type: ${event.type}`);
    }
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

async function handlePaymentSucceeded(intent: { id: string }): Promise<void> {
  const db = getDb();
  await db('payments')
    .where({ provider_payment_id: intent.id })
    .update({ status: PaymentStatus.COMPLETED, captured_at: new Date(), updated_at: new Date() });
  logger.info('Payment marked completed via webhook', { providerPaymentId: intent.id });
}

async function handlePaymentFailed(intent: { id: string; last_payment_error?: { code?: string; message?: string } }): Promise<void> {
  const db = getDb();
  await db('payments')
    .where({ provider_payment_id: intent.id })
    .update({
      status: PaymentStatus.FAILED,
      failure_code: intent.last_payment_error?.code ?? 'UNKNOWN',
      failure_message: intent.last_payment_error?.message ?? 'Payment failed',
      updated_at: new Date(),
    });
  logger.info('Payment marked failed via webhook', { providerPaymentId: intent.id });
}

async function handleDisputeCreated(dispute: { payment_intent: string }): Promise<void> {
  const db = getDb();
  await db('payments')
    .where({ provider_payment_id: dispute.payment_intent })
    .update({ status: PaymentStatus.DISPUTED, updated_at: new Date() });
  logger.warn('Payment disputed via webhook', { providerPaymentId: dispute.payment_intent });
}
