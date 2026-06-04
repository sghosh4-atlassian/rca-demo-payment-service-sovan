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
    const webhooks = await db('webhooks')
      .where({ merchant_id: merchantId, is_active: true })
      .whereRaw('? = ANY(events)', [event]);

    const fullPayload = {
      id: crypto.randomUUID(),
      event,
      created: new Date().toISOString(),
      data: payload,
    };

    // Deliver to each registered webhook (fire-and-forget with retry)
    for (const webhook of webhooks) {
      this.deliverWithRetry(webhook, fullPayload, event).catch((err) =>
        logger.error('Webhook delivery permanently failed', {
          webhookId: webhook.id,
          event,
          error: err.message,
        }),
      );
    }
  }

  private async deliverWithRetry(
    webhook: Record<string, any>,
    payload: Record<string, unknown>,
    event: string,
    attempt = 1,
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = createWebhookSignature(body, webhook.secret);

    try {
      const response = await axios.post(webhook.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Signature': `sha256=${signature}`,
          'X-Payment-Event': event,
          'X-Payment-Delivery-Id': payload['id'] as string,
        },
        timeout: 10_000,
      });

      await this.recordDelivery(webhook.id, event, payload, response.status, true, attempt);
      await getDb()('webhooks')
        .where({ id: webhook.id })
        .update({ last_delivered_at: new Date(), failure_count: 0 });
    } catch (err: any) {
      const statusCode = err.response?.status ?? 0;
      await this.recordDelivery(webhook.id, event, payload, statusCode, false, attempt);

      if (attempt < config.webhook.retryAttempts) {
        const delay = config.webhook.retryDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`Webhook delivery failed, retrying in ${delay}ms`, {
          webhookId: webhook.id,
          attempt,
          error: err.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.deliverWithRetry(webhook, payload, event, attempt + 1);
      }

      // Increment failure count; disable if threshold exceeded
      const db = getDb();
      const updated = await db('webhooks')
        .where({ id: webhook.id })
        .increment('failure_count', 1)
        .returning('failure_count');

      if (updated[0]?.failure_count >= 10) {
        await db('webhooks').where({ id: webhook.id }).update({ is_active: false });
        logger.error('Webhook disabled after repeated failures', { webhookId: webhook.id });
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
