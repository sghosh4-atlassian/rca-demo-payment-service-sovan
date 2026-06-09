import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { ValidationError } from '../utils/errors';
import { Currency, PaymentMethod, PaymentProvider } from '../types';

type ValidateTarget = 'body' | 'query' | 'params';

/**
 * Generic Joi validation middleware factory.
 */
export function validate(schema: Joi.ObjectSchema, target: ValidateTarget = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.validate(req[target as keyof Request], {
      abortEarly: false,
      stripUnknown: true,
    });
    const error = result.error;
    const value: unknown = result.value;

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return next(new ValidationError('Validation failed', details));
    }

    (req[target as keyof Request]) = value;
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const createPaymentSchema = Joi.object({
  merchantId: Joi.string().uuid().required(),
  customerId: Joi.string().uuid().required(),
  orderId: Joi.string().max(255).required(),
  amount: Joi.number().integer().min(1).required()
    .description('Amount in smallest currency unit (e.g. cents)'),
  currency: Joi.string().valid(...Object.values(Currency)).required(),
  method: Joi.string().valid(...Object.values(PaymentMethod)).required(),
  provider: Joi.string().valid(...Object.values(PaymentProvider)).default('stripe'),
  paymentMethodId: Joi.string().optional(),
  description: Joi.string().max(1000).optional(),
  metadata: Joi.object().optional(),
  idempotencyKey: Joi.string().min(8).max(255).required(),
  capture: Joi.boolean().default(true),
  returnUrl: Joi.string().uri().required()
    .description('URL to redirect payer to after approval (PayPal checkout flows)'),
  cancelUrl: Joi.string().uri().required()
    .description('URL to redirect payer to if they cancel (PayPal checkout flows)'),
});

export const capturePaymentSchema = Joi.object({
  amount: Joi.number().integer().min(1).optional(),
});

export const createRefundSchema = Joi.object({
  paymentId: Joi.string().uuid().required(),
  amount: Joi.number().integer().min(1).optional(),
  reason: Joi.string().max(500).optional(),
  initiatedBy: Joi.string().required(),
  metadata: Joi.object().optional(),
});

export const paymentFiltersSchema = Joi.object({
  merchantId: Joi.string().uuid().optional(),
  customerId: Joi.string().uuid().optional(),
  orderId: Joi.string().optional(),
  status: Joi.string().optional(),
  method: Joi.string().valid(...Object.values(PaymentMethod)).optional(),
  currency: Joi.string().valid(...Object.values(Currency)).optional(),
  fromDate: Joi.date().iso().optional(),
  toDate: Joi.date().iso().optional(),
  minAmount: Joi.number().integer().min(0).optional(),
  maxAmount: Joi.number().integer().min(0).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid('created_at', 'amount', 'status').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
});

export const createPaymentMethodSchema = Joi.object({
  customerId: Joi.string().uuid().required(),
  type: Joi.string().valid(...Object.values(PaymentMethod)).required(),
  provider: Joi.string().valid(...Object.values(PaymentProvider)).required(),
  token: Joi.string().required(),
  isDefault: Joi.boolean().default(false),
  billingAddress: Joi.object({
    line1: Joi.string().required(),
    line2: Joi.string().optional(),
    city: Joi.string().required(),
    state: Joi.string().optional(),
    postalCode: Joi.string().required(),
    country: Joi.string().length(2).required(),
  }).optional(),
});
