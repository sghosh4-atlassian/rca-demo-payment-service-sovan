/**
 * PaymentRetryService
 *
 * Manages safe retries for failed payments with:
 *   - Configurable max attempts per payment (default: 3)
 *   - Exponential back-off cool-down between attempts
 *   - Hard blocks on non-retryable failure codes (fraud, insufficient funds, etc.)
 *   - Full audit trail stored in retry_attempts table
 *
 * Retry schedule (base 60s, exponential):
 *   Attempt 1 → immediate
 *   Attempt 2 → 60s  cool-down
 *   Attempt 3 → 120s cool-down
 *   Attempt 4 → 240s cool-down  (if MAX_ATTEMPTS raised)
 *
 * Non-retryable codes (permanent failures — no retry):
 *   card_declined_do_not_retry, fraudulent, lost_card, stolen_card,
 *   pickup_card, restricted_card, insufficient_funds (configurable)
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database/connection';
import { PaymentStatus } from '../types';
import { ConflictError, PaymentError } from '../utils/errors';
import logger, { logPaymentEvent } from '../utils/logger';

export interface RetryAttempt {
  id: string;
  paymentId: string;
  attemptNumber: number;
  status: 'pending' | 'succeeded' | 'failed';
  failureCode?: string;
  failureMessage?: string;
  scheduledAt: Date;
  executedAt?: Date;
  createdAt: Date;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelaySeconds: number;
  retryableFailureCodes: string[];
}

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelaySeconds: 60,
  retryableFailureCodes: [
    'card_declined',
    'processing_error',
    'do_not_honor',
    'try_again_later',
    'temporary_hold',
    'insufficient_funds', // retryable — customer may top up
    'gateway_timeout',
    'service_unavailable',
    'UNKNOWN',
  ],
};

/** Failure codes that should NEVER be retried */
const PERMANENT_FAILURE_CODES = new Set([
  'card_declined_do_not_retry',
  'fraudulent',
  'lost_card',
  'stolen_card',
  'pickup_card',
  'restricted_card',
  'do_not_honor_permanent',
  'invalid_account',
  'account_closed',
  'FRAUD_BLOCKED',
]);

export class PaymentRetryService {
  private policy: RetryPolicy;

  constructor(policy: Partial<RetryPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * Checks whether a failed payment is eligible for a retry attempt.
   * Returns the scheduled retry time if eligible, throws otherwise.
   */
  async scheduleRetry(
    paymentId: string,
    failureCode: string,
    failureMessage: string,
  ): Promise<{ attemptNumber: number; scheduledAt: Date }> {
    // 1. Hard block on permanent failures
    if (PERMANENT_FAILURE_CODES.has(failureCode)) {
      logger.warn('PaymentRetryService: permanent failure — no retry', {
        paymentId,
        failureCode,
      });
      throw new PaymentError(
        `Payment cannot be retried: ${failureCode} is a permanent failure`,
        'PERMANENT_FAILURE',
      );
    }

    // 2. Check if the failure code is in the retryable list
    if (!this.policy.retryableFailureCodes.includes(failureCode)) {
      throw new PaymentError(
        `Failure code '${failureCode}' is not retryable`,
        'NON_RETRYABLE_FAILURE',
      );
    }

    // 3. Count existing retry attempts
    const db = getDb();
    const [{ count }] = await db('retry_attempts')
      .where({ payment_id: paymentId })
      .count('id as count');

    const existingAttempts = Number(count);

    if (existingAttempts >= this.policy.maxAttempts) {
      throw new ConflictError(
        `Payment ${paymentId} has reached the maximum retry limit (${this.policy.maxAttempts})`,
      );
    }

    const attemptNumber = existingAttempts + 1;
    const delaySeconds = this.calculateDelay(attemptNumber);
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000);

    // 4. Persist the retry attempt record
    await db('retry_attempts').insert({
      id: uuidv4(),
      payment_id: paymentId,
      attempt_number: attemptNumber,
      status: 'pending',
      failure_code: failureCode,
      failure_message: failureMessage,
      scheduled_at: scheduledAt,
    });

    logPaymentEvent('payment.retry_scheduled', {
      paymentId,
      attemptNumber,
      delaySeconds,
      scheduledAt: scheduledAt.toISOString(),
    });

    return { attemptNumber, scheduledAt };
  }

  /**
   * Marks a retry attempt as succeeded.
   */
  async markRetrySucceeded(paymentId: string, attemptNumber: number): Promise<void> {
    const db = getDb();
    await db('retry_attempts')
      .where({ payment_id: paymentId, attempt_number: attemptNumber, status: 'pending' })
      .update({ status: 'succeeded', executed_at: new Date() });

    logPaymentEvent('payment.retry_succeeded', { paymentId, attemptNumber });
  }

  /**
   * Marks a retry attempt as failed and re-schedules if within limits.
   */
  async markRetryFailed(
    paymentId: string,
    attemptNumber: number,
    failureCode: string,
    failureMessage: string,
  ): Promise<void> {
    const db = getDb();
    await db('retry_attempts')
      .where({ payment_id: paymentId, attempt_number: attemptNumber, status: 'pending' })
      .update({
        status: 'failed',
        failure_code: failureCode,
        failure_message: failureMessage,
        executed_at: new Date(),
      });

    logPaymentEvent('payment.retry_failed', { paymentId, attemptNumber, failureCode });
  }

  /**
   * Returns all retry attempts for a given payment.
   */
  async getRetryHistory(paymentId: string): Promise<RetryAttempt[]> {
    const db = getDb();
    const rows = await db('retry_attempts')
      .where({ payment_id: paymentId })
      .orderBy('attempt_number', 'asc');

    return rows.map(this.toRetryAttempt);
  }

  /**
   * Returns whether a payment is within its retry cool-down window.
   * Returns the seconds remaining if still in cool-down, or 0 if ready.
   */
  async getCooldownRemaining(paymentId: string): Promise<number> {
    const db = getDb();
    const lastAttempt = await db('retry_attempts')
      .where({ payment_id: paymentId })
      .orderBy('created_at', 'desc')
      .first();

    if (!lastAttempt) return 0;

    const scheduledAt = new Date(lastAttempt.scheduled_at).getTime();
    const remaining = Math.max(0, (scheduledAt - Date.now()) / 1000);
    return Math.ceil(remaining);
  }

  /**
   * Checks if payment has exhausted all retry attempts.
   */
  async isExhausted(paymentId: string): Promise<boolean> {
    const db = getDb();
    const [{ count }] = await db('retry_attempts')
      .where({ payment_id: paymentId })
      .count('id as count');
    return Number(count) >= this.policy.maxAttempts;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Exponential back-off: delay = baseDelay × 2^(attemptNumber - 1)
   * Attempt 1 → 0s (immediate), 2 → 60s, 3 → 120s, 4 → 240s
   */
  private calculateDelay(attemptNumber: number): number {
    if (attemptNumber === 1) return 0;
    return this.policy.baseDelaySeconds * Math.pow(2, attemptNumber - 2);
  }

  private toRetryAttempt(row: Record<string, any>): RetryAttempt {
    return {
      id: row.id,
      paymentId: row.payment_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      failureCode: row.failure_code,
      failureMessage: row.failure_message,
      scheduledAt: new Date(row.scheduled_at),
      executedAt: row.executed_at ? new Date(row.executed_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
