import axios from 'axios';
import { getDb } from '../database/connection';
import { WebhookEvent } from '../types';
import { createWebhookSignature } from '../utils/encryption';
import { config } from '../config';
import logger from '../utils/logger';

export class WebhookService {
  async dispatch(
    merchantId: string,
    event: WebhookEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = getDb();
    const webhooks = (await db('webhooks')
      .where({ merchant_id: merchantId, is_active: true })
      .whereRaw('? = ANY(events)', [event])) as Array<Record<string, unknown>>;

    const fullPayload = {
      id: crypto.randomUUID(),
      event,
      created: new Date().toISOString(),
      data: payload,
    };

    // Deliver to each registered webhook (fire-and-forget with retry)
    for (const webhook of webhooks) {
      this.deliverWithRetry(webhook, fullPayload, event).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Webhook delivery permanently failed', {
          webhookId: webhook.id,
          event,
          error: msg,
        });
      });
    }
  }

  private async deliverWithRetry(
    webhook: Record<string, unknown>,
    payload: Record<string, unknown>,
    event: string,
    attempt = 1,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const webhookSecret = webhook.secret as string;
    const webhookUrl = webhook.url as string;
    const webhookId = webhook.id as string;
    const signature = createWebhookSignature(body, webhookSecret);

    try {
      const response = await axios.post(webhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Signature': `sha256=${signature}`,
          'X-Payment-Event': event,
          'X-Payment-Delivery-Id': payload.id as string,
        },
        timeout: 10_000,
      });

      await this.recordDelivery(webhookId, event, payload, response.status, true, attempt);
      await getDb()('webhooks')
        .where({ id: webhookId })
        .update({ last_delivered_at: new Date(), failure_count: 0 });
    } catch (err: unknown) {
      const statusCode = err instanceof Error && 'response' in err ? (err.response as { status: number }).status : 0;
      const msg = err instanceof Error ? err.message : String(err);
      await this.recordDelivery(webhookId, event, payload, statusCode, false, attempt);

      if (attempt < config.webhook.retryAttempts) {
        const delay = config.webhook.retryDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`Webhook delivery failed, retrying in ${delay}ms`, {
          webhookId,
          attempt,
          error: msg,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.deliverWithRetry(webhook, payload, event, attempt + 1);
      }

      // Increment failure count; disable if threshold exceeded
      const db = getDb();
      const updated = await db('webhooks')
        .where({ id: webhookId })
        .increment('failure_count', 1)
        .returning('failure_count');

      const failureCount = (updated[0] as Record<string, unknown>)?.failure_count as number | undefined;
      if (failureCount && failureCount >= 10) {
        await db('webhooks').where({ id: webhookId }).update({ is_active: false });
        logger.error('Webhook disabled after repeated failures', { webhookId });
      }

      throw err;
    }
  }

  private async recordDelivery(
    webhookId: string,
    event: string,
    payload: Record<string, unknown>,
    statusCode: number,
    success: boolean,
    attempt: number,
  ): Promise<void> {
    const db = getDb();
    await db('webhook_deliveries').insert({
      webhook_id: webhookId,
      event,
      payload: JSON.stringify(payload),
      status_code: statusCode,
      success,
      attempt,
      delivered_at: success ? new Date() : null,
    });
  }
}
