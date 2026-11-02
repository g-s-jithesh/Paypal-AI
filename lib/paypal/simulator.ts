/**
 * ChargebackShield — 100% Offline Deterministic Mock PayPal Simulator
 * Grounded in PRD §6.5, Plan Step 22, and BR-024
 */

import { Database } from 'better-sqlite3';
import { getDb } from '../db';
import {
  PayPalDisputeClient,
  PayPalDisputeResource,
  PayPalActionResponse,
  EvidenceSubmissionPayload,
  SettlementOfferPayload,
  PayPalDisputeAmount,
} from './types';

export const GOLDEN_PERSONAS: Record<string, Partial<PayPalDisputeResource>> = {
  'PP-D-GOLD-001': {
    dispute_id: 'PP-D-GOLD-001',
    status: 'UNDER_REVIEW',
    dispute_amount: { currency_code: 'USD', value: '145.00' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    stage: 'INQUIRY',
    dispute_life_cycle_stage: 'INQUIRY',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
  },
  'PP-D-GOLD-002': {
    dispute_id: 'PP-D-GOLD-002',
    status: 'UNDER_REVIEW',
    dispute_amount: { currency_code: 'USD', value: '85.00' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    stage: 'INQUIRY',
    dispute_life_cycle_stage: 'INQUIRY',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
  },
  'PP-D-GOLD-003': {
    dispute_id: 'PP-D-GOLD-003',
    status: 'UNDER_REVIEW',
    dispute_amount: { currency_code: 'USD', value: '120.00' },
    reason: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
    stage: 'INQUIRY',
    dispute_life_cycle_stage: 'INQUIRY',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
  },
  'PP-D-GOLD-004': {
    dispute_id: 'PP-D-GOLD-004',
    status: 'UNDER_REVIEW',
    dispute_amount: { currency_code: 'USD', value: '450.00' },
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    stage: 'CHARGEBACK',
    dispute_life_cycle_stage: 'CHARGEBACK',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
  },
  'PP-D-GOLD-005': {
    dispute_id: 'PP-D-GOLD-005',
    status: 'UNDER_REVIEW',
    dispute_amount: { currency_code: 'USD', value: '28.00' },
    reason: 'UNAUTHORISED',
    stage: 'INQUIRY',
    dispute_life_cycle_stage: 'INQUIRY',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
  },
};

export class MockPayPalSimulator implements PayPalDisputeClient {
  private memoryDisputes: Map<string, PayPalDisputeResource> = new Map();
  private evidenceSubmissions: Map<string, EvidenceSubmissionPayload[]> = new Map();
  private settlementOffers: Map<string, SettlementOfferPayload[]> = new Map();
  private acceptedClaims: Set<string> = new Set();
  private db?: Database;

  constructor(db?: Database) {
    this.db = db;
    this.seedDefaultDisputes();
  }

  private seedDefaultDisputes(): void {
    for (const [id, persona] of Object.entries(GOLDEN_PERSONAS)) {
      this.memoryDisputes.set(id, {
        dispute_id: id,
        create_time: new Date().toISOString(),
        update_time: new Date().toISOString(),
        dispute_amount: persona.dispute_amount ?? { currency_code: 'USD', value: '100.00' },
        reason: persona.reason ?? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: persona.status ?? 'UNDER_REVIEW',
        stage: persona.stage ?? 'INQUIRY',
        dispute_state: 'REQUIRED_ACTION',
        dispute_life_cycle_stage: (persona.stage as any) ?? 'INQUIRY',
        seller_response_due_date: persona.seller_response_due_date ?? new Date(Date.now() + 864000000).toISOString(),
        disputed_transactions: [
          {
            seller_transaction_id: `TX-${id}`,
            gross_amount: persona.dispute_amount ?? { currency_code: 'USD', value: '100.00' },
            buyer: {
              name: 'Simulated Buyer',
              email: 'buyer@example.com',
            },
          },
        ],
      });
    }
  }

  public async getDispute(disputeId: string): Promise<PayPalDisputeResource> {
    // 1. Try SQLite database first if available
    try {
      const conn = this.db ?? getDb();
      const row = conn.prepare(`
        SELECT d.id, d.paypal_dispute_id, d.reason_code, d.status, d.dispute_amount_cents,
               d.seller_response_due_at, d.stage, d.created_at, d.updated_at,
               o.id as order_id, o.paypal_order_id, o.customer_name, o.customer_email
        FROM disputes d
        LEFT JOIN orders o ON d.order_id = o.id
        WHERE d.paypal_dispute_id = ? OR d.id = ?
      `).get(disputeId, disputeId) as any;

      if (row) {
        const dollars = (row.dispute_amount_cents / 100).toFixed(2);
        return {
          dispute_id: row.paypal_dispute_id ?? row.id,
          create_time: row.created_at,
          update_time: row.updated_at,
          dispute_amount: { currency_code: 'USD', value: dollars },
          reason: row.reason_code,
          status: row.status === 'SUBMITTED' ? 'UNDER_REVIEW' : 'WAITING_FOR_SELLER_RESPONSE',
          stage: row.stage ?? 'INQUIRY',
          dispute_state: 'REQUIRED_ACTION',
          dispute_life_cycle_stage: row.stage ?? 'INQUIRY',
          seller_response_due_date: row.seller_response_due_at,
          disputed_transactions: [
            {
              seller_transaction_id: row.paypal_order_id ?? row.order_id,
              gross_amount: { currency_code: 'USD', value: dollars },
              buyer: {
                name: row.customer_name,
                email: row.customer_email,
              },
            },
          ],
        };
      }
    } catch {
      // Fallback to in-memory store
    }

    // 2. Try in-memory store
    const memDispute = this.memoryDisputes.get(disputeId);
    if (memDispute) {
      return memDispute;
    }

    // 3. Fallback to persona prefix match
    for (const [key, val] of this.memoryDisputes.entries()) {
      if (disputeId.includes(key) || key.includes(disputeId)) {
        return val;
      }
    }

    throw new Error(`PayPal Dispute ${disputeId} not found in simulator`);
  }

  public async fetchDispute(disputeId: string): Promise<PayPalDisputeResource> {
    return this.getDispute(disputeId);
  }

  public async provideEvidence(
    disputeId: string,
    evidence: EvidenceSubmissionPayload
  ): Promise<PayPalActionResponse> {
    const list = this.evidenceSubmissions.get(disputeId) || [];
    list.push(evidence);
    this.evidenceSubmissions.set(disputeId, list);

    const refId = `PP-EV-${Date.now()}`;
    return {
      success: true,
      action: 'SUBMIT_EVIDENCE',
      dispute_id: disputeId,
      paypal_reference_id: refId,
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
    const list = this.settlementOffers.get(disputeId) || [];
    list.push(offer);
    this.settlementOffers.set(disputeId, list);

    let amount: PayPalDisputeAmount = { currency_code: 'USD', value: '0.00' };
    if (offer.amount_cents !== undefined) {
      amount = { currency_code: 'USD', value: (offer.amount_cents / 100).toFixed(2) };
    } else if (offer.offer_amount) {
      amount = offer.offer_amount;
    }

    const refId = `PP-OFF-${Date.now()}`;
    return {
      success: true,
      action: 'MAKE_OFFER',
      dispute_id: disputeId,
      paypal_reference_id: refId,
      status: 'OFFER_PROPOSED',
      offer_amount: amount,
      timestamp: new Date().toISOString(),
    };
  }

  public async acceptClaim(
    disputeId: string,
    _reason?: string
  ): Promise<PayPalActionResponse> {
    this.acceptedClaims.add(disputeId);
    const refId = `PP-ACC-${Date.now()}`;
    return {
      success: true,
      action: 'ACCEPT_CLAIM',
      dispute_id: disputeId,
      paypal_reference_id: refId,
      status: 'CLAIM_ACCEPTED',
      timestamp: new Date().toISOString(),
    };
  }

  public async sendMessage(disputeId: string, _message: string): Promise<PayPalActionResponse> {
    const refId = `PP-MSG-${Date.now()}`;
    return {
      success: true,
      action: 'SEND_MESSAGE',
      dispute_id: disputeId,
      paypal_reference_id: refId,
      status: 'MESSAGE_SENT',
      timestamp: new Date().toISOString(),
    };
  }

  public async getOrder(orderId: string): Promise<any> {
    try {
      const conn = this.db ?? getDb();
      const row = conn.prepare(`
        SELECT id, paypal_order_id, amount_cents, currency, delivery_status, carrier_name, tracking_number
        FROM orders
        WHERE id = ? OR paypal_order_id = ?
      `).get(orderId, orderId) as any;

      if (row) {
        return {
          id: row.paypal_order_id ?? row.id,
          status: 'COMPLETED',
          purchase_units: [
            {
              amount: {
                currency_code: row.currency,
                value: (row.amount_cents / 100).toFixed(2),
              },
            },
          ],
        };
      }
    } catch {
      // Ignore
    }

    return {
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: '100.00',
          },
        },
      ],
    };
  }

  public async verifyWebhookSignature(
    _headers: Headers | Record<string, string>,
    _body: any
  ): Promise<boolean> {
    return true;
  }

  // Inspection helpers for testing & Judge Demo Bar
  public getSubmittedEvidence(disputeId: string): EvidenceSubmissionPayload[] {
    return this.evidenceSubmissions.get(disputeId) || [];
  }

  public getOffers(disputeId: string): SettlementOfferPayload[] {
    return this.settlementOffers.get(disputeId) || [];
  }

  public isClaimAccepted(disputeId: string): boolean {
    return this.acceptedClaims.has(disputeId);
  }
}
