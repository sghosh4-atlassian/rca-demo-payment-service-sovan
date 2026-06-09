// ─────────────────────────────────────────────────────────────────────────────
// Core Domain Types — Payment Service
// ─────────────────────────────────────────────────────────────────────────────

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
  DISPUTED = 'disputed',
  CHARGEBACK = 'chargeback',
}

export enum PaymentMethod {
  CARD = 'card',
  BANK_TRANSFER = 'bank_transfer',
  WALLET = 'wallet',
  PAYPAL = 'paypal',
  CRYPTO = 'crypto',
}

export enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  AUD = 'AUD',
  CAD = 'CAD',
  JPY = 'JPY',
  INR = 'INR',
  SGD = 'SGD',
}

export enum PaymentProvider {
  STRIPE = 'stripe',
  PAYPAL = 'paypal',
  INTERNAL = 'internal',
}

export enum RefundStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TransactionType {
  PAYMENT = 'payment',
  REFUND = 'refund',
  CHARGEBACK = 'chargeback',
  ADJUSTMENT = 'adjustment',
  FEE = 'fee',
  PAYOUT = 'payout',
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  merchantId: string;
  customerId: string;
  orderId: string;
  amount: number;           // stored in smallest currency unit (cents)
  currency: Currency;
  status: PaymentStatus;
  method: PaymentMethod;
  provider: PaymentProvider;
  providerPaymentId?: string;
  providerCustomerId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  failureCode?: string;
  failureMessage?: string;
  capturedAt?: Date;
  refundedAmount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Transaction {
  id: string;
  paymentId: string;
  type: TransactionType;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  providerTransactionId?: string;
  fee?: number;
  net?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface Refund {
  id: string;
  paymentId: string;
  merchantId: string;
  amount: number;
  currency: Currency;
  status: RefundStatus;
  reason?: string;
  providerRefundId?: string;
  initiatedBy: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentMethod_ {
  id: string;
  customerId: string;
  type: PaymentMethod;
  provider: PaymentProvider;
  providerMethodId: string;
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault: boolean;
  isActive: boolean;
  billingAddress?: Address;
  createdAt: Date;
  updatedAt: Date;
}

export interface Customer {
  id: string;
  merchantId: string;
  externalId: string;
  email: string;
  name?: string;
  phone?: string;
  providerCustomerId?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Webhook {
  id: string;
  merchantId: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  isActive: boolean;
  failureCount: number;
  lastDeliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request / Response DTOs
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePaymentDTO {
  merchantId: string;
  customerId: string;
  orderId: string;
  amount: number;
  currency: Currency;
  method: PaymentMethod;
  provider?: PaymentProvider;
  paymentMethodId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  capture?: boolean;  // default: true
  returnUrl: string;
  cancelUrl: string;
}

export interface CapturePaymentDTO {
  paymentId: string;
  amount?: number;  // for partial capture
}

export interface CreateRefundDTO {
  paymentId: string;
  amount?: number;  // omit for full refund
  reason?: string;
  initiatedBy: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentMethodDTO {
  customerId: string;
  type: PaymentMethod;
  provider: PaymentProvider;
  token: string;       // provider-issued token
  isDefault?: boolean;
  billingAddress?: Address;
}

export interface PaymentFilters {
  merchantId?: string;
  customerId?: string;
  orderId?: string;
  status?: PaymentStatus;
  method?: PaymentMethod;
  currency?: Currency;
  fromDate?: Date;
  toDate?: Date;
  minAmount?: number;
  maxAmount?: number;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared / Utility Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;  // ISO 3166-1 alpha-2
}

export type WebhookEvent =
  | 'payment.created'
  | 'payment.completed'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'payment.refunded'
  | 'refund.created'
  | 'refund.completed'
  | 'refund.failed'
  | 'dispute.created'
  | 'dispute.resolved';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fraud Risk Types
// ─────────────────────────────────────────────────────────────────────────────

export enum FraudRiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export interface FraudSignal {
  code: string;
  description: string;
  weight: number;
}

export interface FraudAssessmentSummary {
  score: number;
  riskLevel: FraudRiskLevel;
  blocked: boolean;
  requiresReview: boolean;
  signals: FraudSignal[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryAttemptSummary {
  attemptNumber: number;
  status: 'pending' | 'succeeded' | 'failed';
  scheduledAt: Date;
  failureCode?: string;
}

export interface PaymentWithRiskContext extends Payment {
  fraudAssessment?: FraudAssessmentSummary;
  retryHistory?: RetryAttemptSummary[];
}
