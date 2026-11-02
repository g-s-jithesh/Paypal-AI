/**
 * ChargebackShield — Dual-Mode PayPal Sandbox Mock Simulator
 * Authoritative interface contract from PROJECT.md § Interface Contracts
 */

export interface PayPalDisputeResponse {
  dispute_id: string;
  status: string;
  dispute_amount: { currency_code: string; value: string };
  reason: string;
  stage: string;
  seller_response_due_date: string;
}

export interface PayPalActionResponse {
  success: boolean;
  action: 'SUBMIT_EVIDENCE' | 'MAKE_OFFER' | 'ACCEPT_CLAIM' | 'SEND_MESSAGE';
  dispute_id: string;
  paypal_reference_id: string;
  timestamp: string;
}

export class MockPayPalSimulator {
  private disputes: Map<string, any> = new Map();
  private evidenceSubmissions: Map<string, any[]> = new Map();
  private settlementOffers: Map<string, any[]> = new Map();
  private acceptedClaims: Set<string> = new Set();

  constructor() {
    this.seedDefaultDisputes();
  }

  private seedDefaultDisputes() {
    this.disputes.set('PP-D-GOLD-001', {
      dispute_id: 'PP-D-GOLD-001',
      status: 'UNDER_REVIEW',
      dispute_amount: { currency_code: 'USD', value: '145.00' },
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'INQUIRY',
      seller_response_due_date: new Date(Date.now() + 864000000).toISOString()
    });

    this.disputes.set('PP-D-GOLD-002', {
      dispute_id: 'PP-D-GOLD-002',
      status: 'UNDER_REVIEW',
      dispute_amount: { currency_code: 'USD', value: '85.00' },
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'INQUIRY',
      seller_response_due_date: new Date(Date.now() + 864000000).toISOString()
    });

    this.disputes.set('PP-D-GOLD-003', {
      dispute_id: 'PP-D-GOLD-003',
      status: 'UNDER_REVIEW',
      dispute_amount: { currency_code: 'USD', value: '120.00' },
      reason: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      stage: 'INQUIRY',
      seller_response_due_date: new Date(Date.now() + 864000000).toISOString()
    });
  }

  public async fetchDispute(disputeId: string): Promise<PayPalDisputeResponse> {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`PayPal Dispute ${disputeId} not found in simulator`);
    }
    return dispute;
  }

  public async submitEvidence(disputeId: string, evidence: any): Promise<PayPalActionResponse> {
    if (!this.disputes.has(disputeId)) {
      throw new Error(`PayPal Dispute ${disputeId} not found`);
    }
    const list = this.evidenceSubmissions.get(disputeId) || [];
    list.push(evidence);
    this.evidenceSubmissions.set(disputeId, list);

    return {
      success: true,
      action: 'SUBMIT_EVIDENCE',
      dispute_id: disputeId,
      paypal_reference_id: `PP-EV-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }

  public async makeOffer(disputeId: string, offer: { amount_cents: number; note?: string }): Promise<PayPalActionResponse> {
    if (!this.disputes.has(disputeId)) {
      throw new Error(`PayPal Dispute ${disputeId} not found`);
    }
    const list = this.settlementOffers.get(disputeId) || [];
    list.push(offer);
    this.settlementOffers.set(disputeId, list);

    return {
      success: true,
      action: 'MAKE_OFFER',
      dispute_id: disputeId,
      paypal_reference_id: `PP-OFF-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }

  public async acceptClaim(disputeId: string): Promise<PayPalActionResponse> {
    if (!this.disputes.has(disputeId)) {
      throw new Error(`PayPal Dispute ${disputeId} not found`);
    }
    this.acceptedClaims.add(disputeId);

    return {
      success: true,
      action: 'ACCEPT_CLAIM',
      dispute_id: disputeId,
      paypal_reference_id: `PP-ACC-${Date.now()}`,
      timestamp: new Date().toISOString()
    };
  }

  public getSubmittedEvidence(disputeId: string) {
    return this.evidenceSubmissions.get(disputeId) || [];
  }

  public getOffers(disputeId: string) {
    return this.settlementOffers.get(disputeId) || [];
  }

  public isClaimAccepted(disputeId: string) {
    return this.acceptedClaims.has(disputeId);
  }
}
