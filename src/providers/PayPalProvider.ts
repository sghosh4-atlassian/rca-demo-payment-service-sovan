import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { ProviderError } from '../utils/errors';
import logger from '../utils/logger';

interface ProviderPaymentInput {
  amount: number;
  currency: string;
  paymentMethodId?: string;
  customerId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
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

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + response.data.expires_in * 1000 - 60_000;
    return this.accessToken!;
  }

  async createPayment(input: ProviderPaymentInput): Promise<ProviderPaymentResult> {
    try {
      const token = await this.getAccessToken();
      const amountValue = (input.amount / 100).toFixed(2);

      const response = await this.client.post(
        '/v2/checkout/orders',
        {
          intent: input.capture ? 'CAPTURE' : 'AUTHORIZE',
          purchase_units: [
            {
              amount: { currency_code: input.currency, value: amountValue },
              description: input.description,
            },
          ],
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );

      return {
        providerPaymentId: response.data.id,
        captured: response.data.status === 'COMPLETED',
      };
    } catch (err: any) {
      logger.error('PayPal createPayment error', { error: err.message });
      throw new ProviderError('PayPal', err.response?.data?.message ?? err.message);
    }
  }

  async capturePayment(providerPaymentId: string): Promise<void> {
    try {
      const token = await this.getAccessToken();
      await this.client.post(
        `/v2/checkout/orders/${providerPaymentId}/capture`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (err: any) {
      throw new ProviderError('PayPal', `Capture failed: ${err.message}`);
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
    } catch (err: any) {
      throw new ProviderError('PayPal', `Cancel/void failed: ${err.message}`);
    }
  }

  async createRefund(input: ProviderRefundInput): Promise<ProviderRefundResult> {
    try {
      const token = await this.getAccessToken();
      const body: Record<string, unknown> = {};
      if (input.amount) {
        body.amount = { value: (input.amount / 100).toFixed(2) };
      }
      if (input.reason) body.note_to_payer = input.reason;

      const response = await this.client.post(
        `/v2/payments/captures/${input.providerPaymentId}/refund`,
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );

      return { providerRefundId: response.data.id };
    } catch (err: any) {
      throw new ProviderError('PayPal', `Refund failed: ${err.message}`);
    }
  }
}
