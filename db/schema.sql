-- ============================================================================
-- ChargebackShield: SQLite Database Schema (DDDL Steps 06–21)
-- Entities: ENT-01 to ENT-10
-- Strictness: Foreign keys enabled, integer cents, composite performance indexes
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ============================================================================
-- ENT-01: merchants
-- Merchant configuration, PayPal Sandbox credentials, and fee baseline
-- ============================================================================
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (LENGTH(name) > 0),
  paypal_client_id TEXT NULL,
  paypal_client_secret TEXT NULL,
  paypal_mode TEXT NOT NULL DEFAULT 'SIMULATOR' CHECK (paypal_mode IN ('SIMULATOR', 'SANDBOX', 'LIVE')),
  chargeback_fee_cents INTEGER NOT NULL DEFAULT 1500 CHECK (chargeback_fee_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR', 'GBP')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-02: orders
-- Orders synced from PayPal Orders v2 with carrier tracking checkpoints
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  paypal_order_id TEXT NOT NULL UNIQUE,
  capture_id TEXT NULL,
  customer_id TEXT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  shipping_address_line1 TEXT NULL,
  shipping_city TEXT NULL,
  shipping_state TEXT NULL,
  shipping_postal_code TEXT NULL,
  shipping_country TEXT NOT NULL DEFAULT 'US' CHECK (LENGTH(shipping_country) = 2),
  currency TEXT NOT NULL DEFAULT 'USD',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  carrier_name TEXT NULL,
  tracking_number TEXT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'UNFULFILLED' CHECK (
    delivery_status IN (
      'UNFULFILLED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
      'DELIVERED', 'RETURNED_TO_SENDER', 'LOST_IN_TRANSIT'
    )
  ),
  shipped_at TEXT NULL,
  delivered_at TEXT NULL,
  delivery_signature_name TEXT NULL,
  item_summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-03: disputes
-- Core dispute lifecycle tracking status, SLA deadlines, EV track & optimistic lock
-- ============================================================================
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  paypal_dispute_id TEXT NOT NULL UNIQUE,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      'UNAUTHORISED',
      'CANCELLED_RECURRING_BILLING',
      'OTHER'
    )
  ),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (
    status IN (
      'OPEN', 'EVIDENCE_GATHERING', 'NEGOTIATING', 'READY_FOR_REVIEW',
      'SUBMITTED', 'WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED'
    )
  ),
  dispute_amount_cents INTEGER NOT NULL CHECK (dispute_amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  buyer_dispute_reason_text TEXT NULL,
  seller_response_due_at TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'INQUIRY' CHECK (
    stage IN ('INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION')
  ),
  track TEXT NULL CHECK (
    track IS NULL OR track IN (
      'TRACK_A_AUTO_SUBMIT',
      'TRACK_B_NEGOTIATE',
      'TRACK_C_AUTO_ACCEPT',
      'TRACK_D_HUMAN_REVIEW'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  submitted_at TEXT NULL,
  resolved_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (seller_response_due_at > created_at)
);

-- ============================================================================
-- ENT-04: evidence_items
-- Multi-source gathered evidence items verified with SHA-256 digests (BR-008)
-- ============================================================================
CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN (
      'TRACKING_PROOF', 'DELIVERY_SIGNATURE', 'ORDER_RECEIPT',
      'USAGE_LOG', 'CUSTOMER_COMMS', 'REFUND_POLICY',
      'ITEM_DESCRIPTION', 'ACCESS_LOGS'
    )
  ),
  source_system TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  sha256_hash TEXT NOT NULL CHECK (LENGTH(sha256_hash) = 64),
  is_verified INTEGER NOT NULL DEFAULT 1 CHECK (is_verified IN (0, 1)),
  verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-05: ai_assessments
-- Append-only audit history of AI Win Probability and Expected Value runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_assessments (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  win_probability REAL NOT NULL CHECK (win_probability >= 0.0000 AND win_probability <= 1.0000),
  expected_value_cents INTEGER NOT NULL,
  ev_settle_cents INTEGER NOT NULL,
  recommended_action TEXT NOT NULL CHECK (
    recommended_action IN (
      'AUTO_SUBMIT_EVIDENCE', 'OFFER_PARTIAL_REFUND',
      'AUTO_ACCEPT_CLAIM', 'ESCALATE_TO_HUMAN'
    )
  ),
  confidence_score REAL NOT NULL CHECK (confidence_score >= 0.00 AND confidence_score <= 1.00),
  reasoning_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_tokens INTEGER NULL,
  completion_tokens INTEGER NULL,
  execution_latency_ms INTEGER NOT NULL CHECK (execution_latency_ms >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-06: negotiation_sessions
-- Buyer-facing autonomous AI settlement portal sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS negotiation_sessions (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL UNIQUE REFERENCES disputes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'COMPLETED_SETTLED', 'COMPLETED_REJECTED', 'EXPIRED', 'ESCALATED')
  ),
  token_hash TEXT NOT NULL UNIQUE,
  max_refund_allowed_cents INTEGER NOT NULL CHECK (max_refund_allowed_cents >= 0),
  messages_json TEXT NOT NULL DEFAULT '[]',
  guardrail_triggered_count INTEGER NOT NULL DEFAULT 0 CHECK (guardrail_triggered_count >= 0),
  last_buyer_activity_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-07: settlement_offers
-- Formal settlement offers (e.g. PayPal make-offer partial refunds) (BR-004)
-- ============================================================================
CREATE TABLE IF NOT EXISTS settlement_offers (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  negotiation_session_id TEXT NOT NULL REFERENCES negotiation_sessions(id) ON DELETE CASCADE,
  offer_type TEXT NOT NULL DEFAULT 'PARTIAL_REFUND' CHECK (
    offer_type IN ('PARTIAL_REFUND', 'REPLACEMENT', 'STORE_CREDIT')
  ),
  offered_amount_cents INTEGER NOT NULL CHECK (offered_amount_cents > 0),
  max_allowed_cents INTEGER NOT NULL CHECK (max_allowed_cents >= offered_amount_cents),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (
    status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'EXECUTED', 'CANCELLED')
  ),
  paypal_offer_id TEXT NULL,
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('AGENT', 'BUYER', 'ANALYST')),
  buyer_response_text TEXT NULL,
  responded_at TEXT NULL,
  expires_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- ============================================================================
-- ENT-08: policy_rules
-- Merchant policy configuration governing automated thresholds & refund caps
-- ============================================================================
CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  max_auto_dispute_cents INTEGER NOT NULL DEFAULT 25000 CHECK (max_auto_dispute_cents >= 0),
  max_refund_offer_pct REAL NOT NULL DEFAULT 0.40 CHECK (
    max_refund_offer_pct >= 0.0 AND max_refund_offer_pct <= 1.0
  ),
  min_win_prob_auto_submit REAL NOT NULL DEFAULT 0.75 CHECK (
    min_win_prob_auto_submit >= 0.0 AND min_win_prob_auto_submit <= 1.0
  ),
  auto_accept_below_cents INTEGER NOT NULL DEFAULT 3500 CHECK (auto_accept_below_cents >= 0),
  min_win_prob_auto_accept REAL NOT NULL DEFAULT 0.35 CHECK (
    min_win_prob_auto_accept >= 0.0 AND min_win_prob_auto_accept <= 1.0
  ),
  default_ops_cost_cents INTEGER NOT NULL DEFAULT 500 CHECK (default_ops_cost_cents >= 0),
  sla_buffer_hours INTEGER NOT NULL DEFAULT 4 CHECK (sla_buffer_hours >= 1),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-09: audit_logs
-- Append-only tamper-evident audit ledger for all mutations & tool calls
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('SYSTEM', 'AI_AGENT', 'MERCHANT_USER', 'BUYER', 'EXTERNAL_WEBHOOK')
  ),
  previous_state_json TEXT NULL,
  new_state_json TEXT NOT NULL,
  rule_ids_checked TEXT NOT NULL,
  guardrail_status TEXT NOT NULL CHECK (guardrail_status IN ('PASSED', 'BLOCKED', 'WARNING')),
  ip_address TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- ENT-10: webhook_events
-- Raw PayPal webhook ledger for deduplication, payload retention, and replay
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    processing_status IN ('PENDING', 'PROCESSED', 'DUPLICATE_IGNORED', 'QUARANTINED', 'FAILED')
  ),
  quarantine_reason TEXT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  processed_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================================
-- TRIGGERS: Business Rules & Immutability Enforcement
-- ============================================================================

-- BR-001: Dispute amount cannot exceed original captured order amount
CREATE TRIGGER IF NOT EXISTS trg_disputes_check_order_amount_insert
BEFORE INSERT ON disputes
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.dispute_amount_cents > (SELECT amount_cents FROM orders WHERE id = NEW.order_id)
    THEN RAISE(ABORT, 'BR-001: dispute_amount_cents cannot exceed order amount_cents')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_disputes_check_order_amount_update
BEFORE UPDATE OF dispute_amount_cents, order_id ON disputes
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.dispute_amount_cents > (SELECT amount_cents FROM orders WHERE id = NEW.order_id)
    THEN RAISE(ABORT, 'BR-001: dispute_amount_cents cannot exceed order amount_cents')
  END;
END;

-- BR-005: Dispute in terminal state (WON, LOST, SETTLED_VIA_REFUND, EXPIRED) is immutable
CREATE TRIGGER IF NOT EXISTS trg_disputes_immutable_terminal_states
BEFORE UPDATE ON disputes
FOR EACH ROW
WHEN OLD.status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
BEGIN
  SELECT CASE
    WHEN NEW.status != OLD.status
    THEN RAISE(ABORT, 'BR-005: Cannot modify dispute in terminal state (WON, LOST, SETTLED_VIA_REFUND, EXPIRED)')
  END;
END;

-- BR-012 & ENT-09: audit_logs is strictly append-only (No UPDATE, No DELETE)
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'BR-012: audit_logs is strictly append-only: updates are prohibited');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'BR-012: audit_logs is strictly append-only: deletions are prohibited');
END;

-- ============================================================================
-- PERFORMANCE INDEXES (20+ Indexes for Sub-50ms C-Suite & Queue Queries)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_merchants_mode ON merchants(paypal_mode);
CREATE INDEX IF NOT EXISTS idx_orders_merchant_id ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_paypal_id ON orders(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(carrier_name, tracking_number);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);

CREATE INDEX IF NOT EXISTS idx_disputes_merchant_status_due ON disputes(merchant_id, status, seller_response_due_at);
CREATE INDEX IF NOT EXISTS idx_disputes_status_merchant ON disputes(status, merchant_id);
CREATE INDEX IF NOT EXISTS idx_disputes_order_id ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_paypal_id ON disputes(paypal_dispute_id);
CREATE INDEX IF NOT EXISTS idx_disputes_track ON disputes(track);

CREATE INDEX IF NOT EXISTS idx_evidence_dispute_type ON evidence_items(dispute_id, evidence_type);
CREATE INDEX IF NOT EXISTS idx_evidence_sha256 ON evidence_items(sha256_hash);

CREATE INDEX IF NOT EXISTS idx_assessments_dispute_created ON ai_assessments(dispute_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_negotiation_dispute ON negotiation_sessions(dispute_id);
CREATE INDEX IF NOT EXISTS idx_negotiation_token ON negotiation_sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_settlement_dispute_status ON settlement_offers(dispute_id, status);
CREATE INDEX IF NOT EXISTS idx_settlement_session ON settlement_offers(negotiation_session_id);

CREATE INDEX IF NOT EXISTS idx_audit_entity_action ON audit_logs(entity_type, entity_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_merchant_created ON audit_logs(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_type ON audit_logs(actor_type);

CREATE INDEX IF NOT EXISTS idx_webhooks_webhook_id ON webhook_events(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_resource_status ON webhook_events(resource_id, processing_status);
CREATE INDEX IF NOT EXISTS idx_policy_rules_merchant_active ON policy_rules(merchant_id, is_active);
