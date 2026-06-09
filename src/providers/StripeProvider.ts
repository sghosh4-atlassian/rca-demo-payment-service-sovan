import Stripe from 'stripe';
import { config } from '../config';
import { ProviderError } from '../utils/errors';
import logger from '../utils/logger';

interface ProviderPaymentInput {
  amount: number;
  currency: string;
  paymentMethodId?: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
  capture?: boolean;
}

interface ProviderPaymentResult {
  providerPaymentId: string;
  providerCustomerId?: string;
  captured: boolean;
  fee?: number;
  net?: number;
}

interface ProviderRefundInput {
  providerPaymentId: string;
  amount?: number;
  reason?: string;
}

interface ProviderRefundResult {
  providerRefundId: string;
}

export class StripeProvider {
  private client: Stripe;

  constructor() {
    this.client = new Stripe(config.stripe.secretKey, {
      apiVersion: '2023-10-16',
      maxNetworkRetries: 2,
    });
  }

  async createPayment(input: ProviderPaymentInput): Promise<ProviderPaymentResult> {
    try {
      const intent = await this.client.paymentIntents.create({
        amount: input.amount,
        currency: input.currency.toLowerCase(),
        payment_method: input.paymentMethodId,
        customer: input.customerId,
        description: input.description,
        metadata: input.metadata as Record<string, string>,
        confirm: true,
        capture_method: input.capture ? 'automatic' : 'manual',
        return_url: 'https://example.com/payment/return',
      });

      const captured = intent.status === 'succeeded';
      let fee: number | undefined;
      let net: number | undefined;

      // Fetch balance transaction for fee details if captured
      if (captured && intent.latest_charge) {
        try {
          const charge = await this.client.charges.retrieve(intent.latest_charge as string, {
            expand: ['balance_transaction'],
          });
          const bt = charge.balance_transaction as Stripe.BalanceTransaction | null;
          if (bt) {
            fee = bt.fee;
            net = bt.net;
          }
        } catch {
          // Non-critical — fee info unavailable
        }
      }

      return {
        providerPaymentId: intent.id,
        providerCustomerId: intent.customer as string | undefined,
        captured,
        fee,
        net,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error && 'code' in err ? (err.code as string) : undefined;
      const declineCode = err instanceof Error && 'decline_code' in err ? (err.decline_code as string) : undefined;
      logger.error('Stripe createPayment error', { error: msg, code });
      throw new ProviderError('Stripe', msg, { code, decline_code: declineCode });
    }
  }

  async capturePayment(providerPaymentId: string, amount?: number): Promise<void> {
    try {
      await this.client.paymentIntents.capture(providerPaymentId, {
        amount_to_capture: amount,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('Stripe', `Capture failed: ${msg}`);
    }
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    try {
      await this.client.paymentIntents.cancel(providerPaymentId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('Stripe', `Cancel failed: ${msg}`);
    }
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    try {
      const refund = await this.client.refunds.create({
        payment_intent: input.providerPaymentId,
        amount: input.amount,
        reason: this.mapRefundReason(input.reason),
      });
      return { providerRefundId: refund.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('Stripe', `Refund failed: ${msg}`);
    }
  }

  verifyWebhookSignature(payload: Buffer, signature: string): Stripe.Event {
    try {
      return this.client.webhooks.constructEvent(
        payload,
        signature,
        config.stripe.webhookSecret,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError('Stripe', `Invalid webhook signature: ${msg}`);
    }
  }

  private mapRefundReason(reason?: string): Stripe.RefundCreateParams.Reason | undefined {
    const map: Record<string, Stripe.RefundCreateParams.Reason> = {
      duplicate: 'duplicate',
      fraudulent: 'fraudulent',
      requested_by_customer: 'requested_by_customer',
    };
    return reason ? map[reason] ?? 'requested_by_customer' : undefined;
  }
}
