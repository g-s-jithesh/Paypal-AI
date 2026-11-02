/**
 * ChargebackShield — E2E Test Contracts & Domain Types
 * Grounded in PROJECT.md, PRD, and Data Dictionary v2
 */

export type DisputeStatus =
  | 'OPEN'
  | 'EVIDENCE_GATHERING'
  | 'NEGOTIATING'
  | 'READY_FOR_REVIEW'
  | 'SUBMITTED'
  | 'WON'
  | 'LOST'
  | 'SETTLED_VIA_REFUND'
  | 'EXPIRED';

export type DisputeReasonCode =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
  | 'SIGNIFICANTLY_NOT_AS_DESCRIBED'
  | 'UNAUTHORISED'
  | 'CANCELLED_RECURRING_BILLING'
  | 'OTHER';

export type DisputeStage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';

export type ResolutionTrack =
  | 'TRACK_A_AUTO_SUBMIT'
  | 'TRACK_B_NEGOTIATE'
  | 'TRACK_C_AUTO_ACCEPT'
  | 'TRACK_D_HUMAN_REVIEW';

export type RecommendedAction =
  | 'AUTO_SUBMIT_EVIDENCE'
  | 'OFFER_PARTIAL_REFUND'
  | 'AUTO_ACCEPT_CLAIM'
  | 'ESCALATE_TO_HUMAN';

export type EvidenceType =
  | 'TRACKING_PROOF'
  | 'DELIVERY_SIGNATURE'
  | 'ORDER_RECEIPT'
  | 'USAGE_LOG'
  | 'CUSTOMER_COMMS'
  | 'REFUND_POLICY'
  | 'ITEM_DESCRIPTION'
  | 'ACCESS_LOGS';

export type DeliveryStatus =
  | 'UNFULFILLED'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'RETURNED_TO_SENDER'
  | 'LOST_IN_TRANSIT';

export interface Merchant {
  id: string;
  name: string;
  paypal_client_id: string | null;
  paypal_client_secret: string | null;
  paypal_mode: 'SIMULATOR' | 'SANDBOX' | 'LIVE';
  chargeback_fee_cents: number;
  currency: string;
  created_at?: string;
  updated_at?: string;
}

export interface Order {
  id: string;
  merchant_id: string;
  paypal_order_id: string;
  capture_id: string | null;
  customer_id: string | null;
  customer_email: string;
  customer_name: string;
  shipping_address_line1: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string;
  currency: string;
  amount_cents: number;
  carrier_name: string | null;
  tracking_number: string | null;
  delivery_status: DeliveryStatus;
  shipped_at: string | null;
  delivered_at: string | null;
  delivery_signature_name: string | null;
  item_summary: string;
  created_at?: string;
  updated_at?: string;
}

export interface Dispute {
  id: string;
  merchant_id: string;
  order_id: string;
  paypal_dispute_id: string;
  reason_code: DisputeReasonCode;
  status: DisputeStatus;
  dispute_amount_cents: number;
  currency: string;
  buyer_dispute_reason_text: string | null;
  seller_response_due_at: string;
  stage: DisputeStage;
  track: ResolutionTrack | null;
  version: number;
  submitted_at: string | null;
  resolved_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface EvidenceItem {
  id: string;
  dispute_id: string;
  order_id: string;
  evidence_type: EvidenceType;
  source_system: string;
  title: string;
  content_json: string;
  sha256_hash: string;
  is_verified: number; // 0 | 1
  verified_at?: string;
  created_at?: string;
}

export interface AIAssessment {
  id: string;
  dispute_id: string;
  win_probability: number;
  expected_value_cents: number;
  ev_settle_cents: number;
  recommended_action: RecommendedAction;
  confidence_score: number;
  reasoning_json: string;
  model_version: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  execution_latency_ms: number;
  created_at?: string;
}

export interface NegotiationSession {
  id: string;
  dispute_id: string;
  status: 'ACTIVE' | 'COMPLETED_SETTLED' | 'COMPLETED_REJECTED' | 'EXPIRED' | 'ESCALATED';
  token_hash: string;
  max_refund_allowed_cents: number;
  messages_json: string;
  guardrail_triggered_count: number;
  last_buyer_activity_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface SettlementOffer {
  id: string;
  dispute_id: string;
  negotiation_session_id: string;
  offer_type: 'PARTIAL_REFUND' | 'REPLACEMENT' | 'STORE_CREDIT';
  offered_amount_cents: number;
  max_allowed_cents: number;
  status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'EXECUTED' | 'CANCELLED';
  paypal_offer_id: string | null;
  proposed_by: 'AGENT' | 'BUYER' | 'ANALYST';
  buyer_response_text: string | null;
  responded_at: string | null;
  expires_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PolicyRule {
  id: string;
  merchant_id: string;
  max_auto_dispute_cents: number;
  max_refund_offer_pct: number;
  min_win_prob_auto_submit: number;
  auto_accept_below_cents: number;
  min_win_prob_auto_accept: number;
  default_ops_cost_cents: number;
  sla_buffer_hours: number;
  is_active: number;
  version: number;
  created_at?: string;
  updated_at?: string;
}

export interface AuditLog {
  id: string;
  merchant_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_type: 'SYSTEM' | 'AI_AGENT' | 'MERCHANT_USER' | 'BUYER' | 'EXTERNAL_WEBHOOK';
  previous_state_json: string | null;
  new_state_json: string;
  rule_ids_checked: string;
  guardrail_status: 'PASSED' | 'BLOCKED' | 'WARNING';
  ip_address: string | null;
  created_at?: string;
}

export interface WebhookEvent {
  id: string;
  webhook_id: string;
  event_type: string;
  resource_id: string;
  payload_json: string;
  processing_status: 'PENDING' | 'PROCESSED' | 'DUPLICATE_IGNORED' | 'QUARANTINED' | 'FAILED';
  quarantine_reason: string | null;
  retry_count: number;
  processed_at?: string | null;
  created_at?: string;
}

export interface CSuiteKPIReport {
  kpi_001_win_rate_pct: number;
  kpi_002_net_revenue_saved_dollars: number;
  kpi_003_deflection_rate_pct: number;
  kpi_004_fee_avoidance_dollars: number;
  kpi_005_autonomous_resolution_rate_pct: number;
  kpi_006_mttes_seconds: number | null;
  total_disputes: number;
}
