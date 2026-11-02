/**
 * ChargebackShield — Live PayPal REST Client
 * Integrates with PayPal Disputes API v1 & Orders API v2
 * Grounded in PRD §6.5 and Plan Step 23
 */

import {
  PayPalDisputeClient,
  PayPalDisputeResource,
  PayPalActionResponse,
  EvidenceSubmissionPayload,
  SettlementOfferPayload,
} from './types';

export interface LivePayPalConfig {
  clientId?: string;
  clientSecret?: string;
  environment?: 'sandbox' | 'live';
  webhookId?: string;
}

export class LivePayPalClient implements PayPalDisputeClient {
  private clientId: string;
  private clientSecret: string;
  private baseUrl: string;
  private webhookId: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(config?: LivePayPalConfig) {
    this.clientId = (config?.clientId ?? process.env.PAYPAL_CLIENT_ID ?? '').trim();
    this.clientSecret = (config?.clientSecret ?? process.env.PAYPAL_CLIENT_SECRET ?? '').trim();
    const env = config?.environment ?? (process.env.PAYPAL_ENVIRONMENT === 'live' ? 'live' : 'sandbox');
    this.baseUrl = env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    this.webhookId = (config?.webhookId ?? process.env.PAYPAL_WEBHOOK_ID ?? '').trim();
  }

  /**
   * Acquires or returns cached OAuth2 Bearer token using Client Credentials grant.
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60000) {
      return this.cachedToken.token;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error('PayPal client credentials missing (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
    }

    const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`PayPal OAuth2 failure (${response.status}): ${text}`);
      }

      const data = await response.json();
      const expiresInSec = data.expires_in ?? 32400;
      this.cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      };

      return data.access_token;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Helper to execute authenticated requests with automatic retry on token expiration.
   */
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    let token = await this.getAccessToken();

    const execute = async (authToken: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        return res;
      } finally {
        clearTimeout(timeout);
      }
    };

    let res = await execute(token);

    // Auto-retry once on 401
    if (res.status === 401) {
      this.cachedToken = null;
      token = await this.getAccessToken();
      res = await execute(token);
    }

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`PayPal API Error [${res.status} ${path}]: ${errorText}`);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  public async getDispute(disputeId: string): Promise<PayPalDisputeResource> {
    return this.request<PayPalDisputeResource>(`/v1/customer/disputes/${encodeURIComponent(disputeId)}`, {
      method: 'GET',
    });
  }

  public async fetchDispute(disputeId: string): Promise<PayPalDisputeResource> {
    return this.getDispute(disputeId);
  }

  public async provideEvidence(
    disputeId: string,
    evidence: EvidenceSubmissionPayload
  ): Promise<PayPalActionResponse> {
    const payload: any = {
      evidence_type: evidence.evidence_type ?? 'PROOF_OF_DELIVERY',
      notes: evidence.notes ?? 'Submitted automatically by ChargebackShield Autopilot',
    };

    if (evidence.tracking_number && evidence.carrier) {
      payload.evidence_info = {
        tracking_info: [
          {
            carrier_name: evidence.carrier,
            tracking_number: evidence.tracking_number,
          },
        ],
      };
    } else if (evidence.evidence_info) {
      payload.evidence_info = evidence.evidence_info;
    }

    const res = await this.request<any>(
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    return {
      success: true,
      action: 'SUBMIT_EVIDENCE',
      dispute_id: disputeId,
      paypal_reference_id: res?.id ?? `PP-EV-${Date.now()}`,
      status: 'EVIDENCE_SUBMITTED',
      timestamp: new Date().toISOString(),
    };
  }

  public async submitEvidence(
    disputeId: string,
    evidence: EvidenceSubmissionPayload
  ): Promise<PayPalActionResponse> {
    return this.provideEvidence(disputeId, evidence);
  }

  public async makeOffer(
    disputeId: string,
    offer: SettlementOfferPayload
  ): Promise<PayPalActionResponse> {
    let amount = offer.offer_amount;
    if (!amount && offer.amount_cents !== undefined) {
      amount = {
        currency_code: 'USD',
        value: (offer.amount_cents / 100).toFixed(2),
      };
    }

    const payload = {
      offer_type: offer.offer_type ?? 'REFUND',
      offer_amount: amount ?? { currency_code: 'USD', value: '0.00' },
      note: offer.note ?? 'ChargebackShield Autonomous Settlement Offer',
    };

    const res = await this.request<any>(
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/make-offer`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    return {
      success: true,
      action: 'MAKE_OFFER',
      dispute_id: disputeId,
      paypal_reference_id: res?.id ?? `PP-OFF-${Date.now()}`,
      status: 'OFFER_PROPOSED',
      offer_amount: payload.offer_amount,
      timestamp: new Date().toISOString(),
    };
  }

  public async acceptClaim(disputeId: string, reason?: string): Promise<PayPalActionResponse> {
    const payload = {
      note: reason ?? 'Auto-accepted by ChargebackShield Policy Engine',
    };

    const res = await this.request<any>(
      `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    return {
      success: true,
      action: 'ACCEPT_CLAIM',
      dispute_id: disputeId,
      paypal_reference_id: res?.id ?? `PP-ACC-${Date.now()}`,
      status: 'CLAIM_ACCEPTED',
      timestamp: new Date().toISOString(),
    };
  }

  public async getOrder(orderId: string): Promise<any> {
    return this.request<any>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
    });
  }

  public async verifyWebhookSignature(
    headers: Headers | Record<string, string>,
    body: any
  ): Promise<boolean> {
    try {
      const getHeader = (name: string): string => {
        if ('get' in headers && typeof headers.get === 'function') {
          return headers.get(name) || '';
        }
        return (headers as Record<string, string>)[name.toLowerCase()] || (headers as Record<string, string>)[name] || '';
      };

      const transmissionId = getHeader('paypal-transmission-id');
      const transmissionTime = getHeader('paypal-transmission-time');
      const transmissionSig = getHeader('paypal-transmission-sig');
      const certUrl = getHeader('paypal-cert-url');
      const authAlgo = getHeader('paypal-auth-algo');

      if (!transmissionId || !transmissionSig) {
        return false;
      }

      const payload = {
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        cert_url: certUrl,
        auth_algo: authAlgo,
        transmission_sig: transmissionSig,
        webhook_id: this.webhookId,
        webhook_event: typeof body === 'string' ? JSON.parse(body) : body,
      };

      const res = await this.request<{ verification_status: string }>(
        '/v1/notifications/verify-webhook-signature',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );

      return res.verification_status === 'SUCCESS';
    } catch {
      return false;
    }
  }
}
