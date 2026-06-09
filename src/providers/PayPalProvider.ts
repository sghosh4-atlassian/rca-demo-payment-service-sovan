import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { ProviderError } from '../utils/errors';
import logger from '../utils/logger';

interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  countryCode: string; // ISO 3166-1 alpha-2
}

interface ProviderPaymentInput {
  amount: number;
  currency: string;
  paymentMethodId?: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  capture?: boolean;
  // New fields — required for redirect-based PayPal checkout flows
  orderId?: string;
  returnUrl: string;
  cancelUrl: string;
  shippingAddress?: ShippingAddress;
  softDescriptor?: string; // appears on payer's card/bank statement
}

interface ProviderPaymentResult {
  providerPaymentId: string;
  providerOrderId: string;       // PayPal order ID (distinct from authorization ID)
  providerCustomerId?: string;
  captured: boolean;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  payerEmail?: string;           // populated when payer has approved the order
  approvalUrl?: string;          // redirect URL for payer approval (PAYER_ACTION_REQUIRED flows)
  fee?: number;
  net?: number;
}

interface ProviderCaptureResult {
  providerCaptureId: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED';
  fee?: number;
  net?: number;
}

interface ProviderRefundInput {
  providerPaymentId: string;
  amount?: number;
  currency?: string;             // must match original payment currency
  reason?: string;
  invoiceId?: string;            // merchant-supplied invoice reference
}

interface ProviderRefundResult {
  providerRefundId: string;
  status: 'CANCELLED' | 'PENDING' | 'COMPLETED';
  createTime: string;            // ISO 8601 timestamp from PayPal
}

export class PayPalProvider {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    const baseURL =
      config.paypal.mode === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

    this.client = axios.create({ baseURL, timeout: 15_000 });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const credentials = Buffer.from(
      `${config.paypal.clientId}:${config.paypal.clientSecret}`,
    ).toString('base64');

    const response = await axios.post(
      `${this.client.defaults.baseURL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    const tokenData = response.data as { access_token: string; expires_in: number };
    this.accessToken = tokenData.access_token;
    this.tokenExpiry = Date.now() + tokenData.expires_in * 1000 - 60_000;
    return this.accessToken;
  }

  async createPayment(input: ProviderPaymentInput): Promise<ProviderPaymentResult> {
    try {
      const token = await this.getAccessToken();
      const amountValue = (input.amount / 100).toFixed(2);

      const purchaseUnit: Record<string, unknown> = {
        amount: { currency_code: input.currency, value: amountValue },
        description: input.description,
        soft_descriptor: input.softDescriptor,
        custom_id: input.orderId,
      };

      if (input.shippingAddress) {
        purchaseUnit.shipping = {
          address: {
            address_line_1: input.shippingAddress.line1,
            address_line_2: input.shippingAddress.line2,
            admin_area_2: input.shippingAddress.city,
            admin_area_1: input.shippingAddress.state,
            postal_code: input.shippingAddress.postalCode,
            country_code: input.shippingAddress.countryCode,
          },
        };
      }

      const response = await this.client.post(
        '/v2/checkout/orders',
        {
          intent: input.capture ? 'CAPTURE' : 'AUTHORIZE',
          purchase_units: [purchaseUnit],
          application_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            shipping_preference: input.shippingAddress ? 'SET_PROVIDED_ADDRESS' : 'GET_FROM_FILE',
            user_action: 'PAY_NOW',
          },
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );

      const orderData = response.data as {
        id: string;
        status: ProviderPaymentResult['status'];
        links?: { rel: string; href: string }[];
        payer?: { email_address?: string };
      };

      const approvalLink = orderData.links?.find((l) => l.rel === 'approve');

      return {
        providerPaymentId: orderData.id,
        providerOrderId: orderData.id,
        captured: orderData.status === 'COMPLETED',
        status: orderData.status,
        payerEmail: orderData.payer?.email_address,
        approvalUrl: approvalLink?.href,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const providerMessage =
        (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? message;
      logger.error('PayPal createPayment error', { error: message });
      throw new ProviderError('PayPal', providerMessage);
    }
  }

  async capturePayment(providerPaymentId: string): Promise<ProviderCaptureResult> {
    try {
      const token = await this.getAccessToken();
      const response = await this.client.post(
        `/v2/checkout/orders/${providerPaymentId}/capture`,
        {},
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );

      const captureData = response.data as {
        id: string;
        status: ProviderCaptureResult['status'];
        purchase_units?: {
          payments?: {
            captures?: {
              id: string;
              status: ProviderCaptureResult['status'];
              seller_receivable_breakdown?: {
                paypal_fee?: { value: string };
                net_amount?: { value: string };
              };
            }[];
          };
        }[];
      };

      const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
      const sellerBreakdown = capture?.seller_receivable_breakdown;
      const feeValue = sellerBreakdown?.paypal_fee?.value;
      const netValue = sellerBreakdown?.net_amount?.value;

      return {
        providerCaptureId: capture?.id ?? captureData.id,
        status: capture?.status ?? captureData.status,
        fee: feeValue !== undefined ? Math.round(parseFloat(feeValue) * 100) : undefined,
        net: netValue !== undefined ? Math.round(parseFloat(netValue) * 100) : undefined,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError('PayPal', `Capture failed: ${message}`);
    }
  }

  async cancelPayment(providerPaymentId: string): Promise<void> {
    // PayPal authorized payments are voided, not "cancelled"
    try {
      const token = await this.getAccessToken();
      await this.client.post(
        `/v2/payments/authorizations/${providerPaymentId}/void`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError('PayPal', `Cancel/void failed: ${message}`);
    }
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    try {
      const token = await this.getAccessToken();
      const body: Record<string, unknown> = {};

      if (input.amount) {
        body.amount = {
          value: (input.amount / 100).toFixed(2),
          currency_code: input.currency,
        };
      }
      if (input.reason) { body.note_to_payer = input.reason; }
      if (input.invoiceId) { body.invoice_id = input.invoiceId; }

      const response = await this.client.post(
        `/v2/payments/captures/${input.providerPaymentId}/refund`,
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );

      const refundData = response.data as {
        id: string;
        status: ProviderRefundResult['status'];
        create_time: string;
      };

      return {
        providerRefundId: refundData.id,
        status: refundData.status,
        createTime: refundData.create_time,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderError('PayPal', `Refund failed: ${message}`);
    }
  }
}
