/**
 * ChargebackShield — PayPal REST API Types & Client Interface Contracts
 * Matching PayPal Disputes API v1 and Orders API v2
 */

export interface PayPalDisputeAmount {
  currency_code: string;
  value: string; // e.g. "145.00"
}

export interface PayPalDisputedTransaction {
  seller_transaction_id: string;
  buyer_transaction_id?: string;
  gross_amount: PayPalDisputeAmount;
  buyer?: {
    name?: string;
    email?: string;
  };
}

export interface PayPalDisputeResource {
  dispute_id: string;
  create_time: string;
  update_time: string;
  dispute_amount: PayPalDisputeAmount;
  reason:
    | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
    | 'SIGNIFICANTLY_NOT_AS_DESCRIBED'
    | 'UNAUTHORISED'
    | 'CANCELLED_RECURRING_BILLING'
    | 'OTHER';
  status:
    | 'OPEN'
    | 'WAITING_FOR_SELLER_RESPONSE'
    | 'UNDER_REVIEW'
    | 'RESOLVED'
    | 'OTHER';
  dispute_state?: 'REQUIRED_ACTION' | 'UNDER_REVIEW' | 'RESOLVED';
  dispute_life_cycle_stage?: 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';
  stage?: string;
  seller_response_due_date: string;
  disputed_transactions?: PayPalDisputedTransaction[];
  offer?: {
    offer_type: string;
    offer_amount: PayPalDisputeAmount;
    note?: string;
  };
  evidence?: Array<{
    evidence_type: string;
    notes?: string;
    date: string;
  }>;
}

export interface PayPalActionResponse {
  success: boolean;
  action: 'SUBMIT_EVIDENCE' | 'MAKE_OFFER' | 'ACCEPT_CLAIM' | 'SEND_MESSAGE';
  dispute_id: string;
  paypal_reference_id: string;
  status: string;
  timestamp: string;
  offer_amount?: PayPalDisputeAmount;
  error?: string;
}

export interface EvidenceSubmissionPayload {
  evidence_type?: 'PROOF_OF_DELIVERY' | 'PROOF_OF_SERVICE' | 'CUSTOMER_COMMUNICATION' | 'REFUND_POLICY' | 'ITEM_DESCRIPTION' | string;
  notes?: string;
  evidence_info?: {
    tracking_info?: Array<{
      carrier_name: string;
      tracking_number: string;
    }>;
  };
  tracking_number?: string;
  carrier?: string;
  [key: string]: any;
}

export interface SettlementOfferPayload {
  offer_type?: 'REFUND' | 'REPLACEMENT' | string;
  offer_amount?: PayPalDisputeAmount;
  amount_cents?: number;
  note?: string;
}

export interface PayPalDisputeClient {
  getDispute(disputeId: string): Promise<PayPalDisputeResource>;
  fetchDispute?(disputeId: string): Promise<PayPalDisputeResource>;
  provideEvidence(disputeId: string, evidence: EvidenceSubmissionPayload): Promise<PayPalActionResponse>;
  submitEvidence?(disputeId: string, evidence: EvidenceSubmissionPayload): Promise<PayPalActionResponse>;
  makeOffer(disputeId: string, offer: SettlementOfferPayload): Promise<PayPalActionResponse>;
  acceptClaim(disputeId: string, reason?: string): Promise<PayPalActionResponse>;
  sendMessage?(disputeId: string, message: string): Promise<PayPalActionResponse>;
  getOrder?(orderId: string): Promise<any>;
  verifyWebhookSignature?(headers: Headers | Record<string, string>, body: any): Promise<boolean>;
}

export type PayPalSubmissionResult = PayPalActionResponse;
export type PayPalOfferResult = PayPalActionResponse;
export type PayPalAcceptResult = PayPalActionResponse;
