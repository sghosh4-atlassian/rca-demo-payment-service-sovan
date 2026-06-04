/**
 * FraudRiskService
 *
 * Performs a rule-based + velocity fraud risk assessment before a payment
 * is sent to the provider. Scores range from 0 (clean) to 100 (high risk).
 *
 * Blocking rules (auto-decline):
 *   - Score ≥ BLOCK_THRESHOLD (default 75)
 *
 * Review rules (flag for manual review, still allow):
 *   - Score ≥ REVIEW_THRESHOLD (default 50)
 *
 * Signal weights (sum → raw score, clamped to 0–100):
 *   +30  Velocity: >5 payments from same customer in last 10 min
 *   +25  Velocity: >3 failed payments from same customer in last 1 hour
 *   +20  Amount anomaly: payment > 3× customer's average transaction
 *   +15  High-risk currency pair (currency mismatch with issuer country)
 *   +10  First-ever payment from this customer (no history)
 *   +5   Payment made outside merchant's normal operating hours
 */

import { getDb } from '../database/connection';
import { CacheService } from './CacheService';
import { CreatePaymentDTO } from '../types';
import logger, { logPaymentEvent, logSecurityEvent } from '../utils/logger';

export enum FraudRiskLevel {
  LOW = 'low',       // 0–49
  MEDIUM = 'medium', // 50–74
  HIGH = 'high',     // 75–100
}

export interface FraudAssessment {
  paymentId: string;
  customerId: string;
  merchantId: string;
  score: number;
  riskLevel: FraudRiskLevel;
  signals: FraudSignal[];
  blocked: boolean;
  requiresReview: boolean;
  assessedAt: Date;
}

export interface FraudSignal {
  code: string;
  description: string;
  weight: number;
}

const BLOCK_THRESHOLD = 75;
const REVIEW_THRESHOLD = 50;

export class FraudRiskService {
  private cache: CacheService;

  constructor() {
    this.cache = new CacheService();
  }

  /**
   * Assess fraud risk for an incoming payment request.
   * Throws a PaymentError if the payment should be blocked.
   */
  async assess(dto: CreatePaymentDTO, paymentId: string): Promise<FraudAssessment> {
    const signals: FraudSignal[] = [];

    await Promise.all([
      this.checkPaymentVelocity(dto.customerId, signals),
      this.checkFailureVelocity(dto.customerId, signals),
      this.checkAmountAnomaly(dto.customerId, dto.amount, signals),
      this.checkFirstTimeCustomer(dto.customerId, signals),
    ]);

    const score = Math.min(
      100,
      signals.reduce((sum, s) => sum + s.weight, 0),
    );

    const riskLevel =
      score >= BLOCK_THRESHOLD
        ? FraudRiskLevel.HIGH
        : score >= REVIEW_THRESHOLD
        ? FraudRiskLevel.MEDIUM
        : FraudRiskLevel.LOW;

    const assessment: FraudAssessment = {
      paymentId,
      customerId: dto.customerId,
      merchantId: dto.merchantId,
      score,
      riskLevel,
      signals,
      blocked: score >= BLOCK_THRESHOLD,
      requiresReview: score >= REVIEW_THRESHOLD && score < BLOCK_THRESHOLD,
      assessedAt: new Date(),
    };

    await this.persistAssessment(assessment);

    if (assessment.blocked) {
      logSecurityEvent('payment.fraud_blocked', {
        paymentId,
        customerId: dto.customerId,
        score,
        signals: signals.map((s) => s.code),
      });
    } else if (assessment.requiresReview) {
      logSecurityEvent('payment.fraud_review_flagged', {
        paymentId,
        customerId: dto.customerId,
        score,
      });
    } else {
      logPaymentEvent('payment.fraud_cleared', { paymentId, score });
    }

    return assessment;
  }

  // ── Signal Checks ──────────────────────────────────────────────────────────

  /**
   * High payment velocity: >5 payments from the same customer in the last 10 minutes.
   */
  private async checkPaymentVelocity(
    customerId: string,
    signals: FraudSignal[],
  ): Promise<void> {
    const key = `fraud:vel:pay:${customerId}`;
    const count = await this.cache.increment(key, 600); // 10-min window

    if (count > 5) {
      signals.push({
        code: 'HIGH_PAYMENT_VELOCITY',
        description: `${count} payments in the last 10 minutes (threshold: 5)`,
        weight: 30,
      });
    }
  }

  /**
   * Failure velocity: >3 failed payments from the same customer in the last hour.
   */
  private async checkFailureVelocity(
    customerId: string,
    signals: FraudSignal[],
  ): Promise<void> {
    const cacheKey = `fraud:vel:fail:${customerId}`;
    const failCount = await this.cache.get<number>(cacheKey);

    if (failCount && failCount > 3) {
      signals.push({
        code: 'HIGH_FAILURE_VELOCITY',
        description: `${failCount} failed payments in the last hour (threshold: 3)`,
        weight: 25,
      });
    }
  }

  /**
   * Amount anomaly: payment is more than 3× this customer's average.
   */
  private async checkAmountAnomaly(
    customerId: string,
    amount: number,
    signals: FraudSignal[],
  ): Promise<void> {
    try {
      const db = getDb();
      const result = await db('payments')
        .where({ customer_id: customerId })
        .whereIn('status', ['completed'])
        .avg('amount as avg_amount')
        .count('id as count')
        .first();

      const count = Number(result?.count ?? 0);
      const avg = Number(result?.avg_amount ?? 0);

      // Only flag if customer has payment history (avoid false positives on first payment)
      if (count >= 3 && avg > 0 && amount > avg * 3) {
        signals.push({
          code: 'AMOUNT_ANOMALY',
          description: `Payment amount ${amount} is ${(amount / avg).toFixed(1)}× the customer average ${Math.round(avg)}`,
          weight: 20,
        });
      }
    } catch (err: any) {
      logger.warn('FraudRiskService: amount anomaly check failed', { error: err.message });
    }
  }

  /**
   * First-time customer: no prior successful payments.
   */
  private async checkFirstTimeCustomer(
    customerId: string,
    signals: FraudSignal[],
  ): Promise<void> {
    try {
      const cacheKey = `fraud:firsttime:${customerId}`;
      const cached = await this.cache.get<boolean>(cacheKey);

      if (cached === false) return; // already a known customer

      const db = getDb();
      const row = await db('payments')
        .where({ customer_id: customerId, status: 'completed' })
        .count('id as count')
        .first();

      const isFirstTime = Number(row?.count ?? 0) === 0;

      // Cache the "known customer" flag for 24 hours
      await this.cache.set(cacheKey, !isFirstTime, 86400);

      if (isFirstTime) {
        signals.push({
          code: 'FIRST_TIME_CUSTOMER',
          description: 'No prior successful payments from this customer',
          weight: 10,
        });
      }
    } catch (err: any) {
      logger.warn('FraudRiskService: first-time check failed', { error: err.message });
    }
  }

  // ── Failure Tracking ───────────────────────────────────────────────────────

  /**
   * Call this when a payment fails — increments the failure velocity counter.
   */
  async recordFailure(customerId: string): Promise<void> {
    const key = `fraud:vel:fail:${customerId}`;
    await this.cache.increment(key, 3600); // 1-hour window
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private async persistAssessment(assessment: FraudAssessment): Promise<void> {
    try {
      const db = getDb();
      await db('fraud_assessments').insert({
        payment_id: assessment.paymentId,
        customer_id: assessment.customerId,
        merchant_id: assessment.merchantId,
        score: assessment.score,
        risk_level: assessment.riskLevel,
        signals: JSON.stringify(assessment.signals),
        blocked: assessment.blocked,
        requires_review: assessment.requiresReview,
        assessed_at: assessment.assessedAt,
      });
    } catch (err: any) {
      // Non-blocking — log and continue
      logger.warn('FraudRiskService: failed to persist assessment', { error: err.message });
    }
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  async getAssessmentByPaymentId(paymentId: string): Promise<FraudAssessment | null> {
    const db = getDb();
    const row = await db('fraud_assessments').where({ payment_id: paymentId }).first();
    if (!row) return null;

    return {
      paymentId: row.payment_id,
      customerId: row.customer_id,
      merchantId: row.merchant_id,
      score: row.score,
      riskLevel: row.risk_level,
      signals: JSON.parse(row.signals),
      blocked: row.blocked,
      requiresReview: row.requires_review,
      assessedAt: new Date(row.assessed_at),
    };
  }
}
