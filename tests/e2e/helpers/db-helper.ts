/**
 * ChargebackShield — E2E Test SQLite Database Helper
 * Provides seamless isolated in-memory or file-backed database test harness.
 * Automatically utilizes better-sqlite3 or Node 24 native node:sqlite.
 */

import { CSuiteKPIReport } from './contracts';

export interface SqliteDbAdapter {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: any[]): { changes: number; lastInsertRowid?: number | bigint };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
  close(): void;
}

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (LENGTH(name) > 0),
  paypal_client_id TEXT NULL,
  paypal_client_secret TEXT NULL,
  paypal_mode TEXT NOT NULL DEFAULT 'SIMULATOR' CHECK (paypal_mode IN ('SIMULATOR', 'SANDBOX', 'LIVE')),
  chargeback_fee_cents INTEGER NOT NULL DEFAULT 1500 CHECK (chargeback_fee_cents >= 0 AND typeof(chargeback_fee_cents) = 'integer'),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR', 'GBP')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY NOT NULL,
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
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
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

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY NOT NULL,
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
  dispute_amount_cents INTEGER NOT NULL CHECK (dispute_amount_cents > 0 AND typeof(dispute_amount_cents) = 'integer'),
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

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY NOT NULL,
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

CREATE TABLE IF NOT EXISTS ai_assessments (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  win_probability REAL NOT NULL CHECK (win_probability >= 0.0000 AND win_probability <= 1.0000),
  expected_value_cents INTEGER NOT NULL CHECK (typeof(expected_value_cents) = 'integer'),
  ev_settle_cents INTEGER NOT NULL CHECK (typeof(ev_settle_cents) = 'integer'),
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

CREATE TABLE IF NOT EXISTS negotiation_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL UNIQUE REFERENCES disputes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'COMPLETED_SETTLED', 'COMPLETED_REJECTED', 'EXPIRED', 'ESCALATED')
  ),
  token_hash TEXT NOT NULL UNIQUE,
  max_refund_allowed_cents INTEGER NOT NULL CHECK (max_refund_allowed_cents >= 0 AND typeof(max_refund_allowed_cents) = 'integer'),
  messages_json TEXT NOT NULL DEFAULT '[]',
  guardrail_triggered_count INTEGER NOT NULL DEFAULT 0 CHECK (guardrail_triggered_count >= 0),
  last_buyer_activity_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS settlement_offers (
  id TEXT PRIMARY KEY NOT NULL,
  dispute_id TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  negotiation_session_id TEXT NOT NULL REFERENCES negotiation_sessions(id) ON DELETE CASCADE,
  offer_type TEXT NOT NULL DEFAULT 'PARTIAL_REFUND' CHECK (
    offer_type IN ('PARTIAL_REFUND', 'REPLACEMENT', 'STORE_CREDIT')
  ),
  offered_amount_cents INTEGER NOT NULL CHECK (offered_amount_cents > 0 AND typeof(offered_amount_cents) = 'integer'),
  max_allowed_cents INTEGER NOT NULL CHECK (max_allowed_cents >= offered_amount_cents AND typeof(max_allowed_cents) = 'integer'),
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

CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY NOT NULL,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  max_auto_dispute_cents INTEGER NOT NULL DEFAULT 25000 CHECK (max_auto_dispute_cents >= 0 AND typeof(max_auto_dispute_cents) = 'integer'),
  max_refund_offer_pct REAL NOT NULL DEFAULT 0.40 CHECK (
    max_refund_offer_pct >= 0.0 AND max_refund_offer_pct <= 1.0
  ),
  min_win_prob_auto_submit REAL NOT NULL DEFAULT 0.75 CHECK (
    min_win_prob_auto_submit >= 0.0 AND min_win_prob_auto_submit <= 1.0
  ),
  auto_accept_below_cents INTEGER NOT NULL DEFAULT 3500 CHECK (auto_accept_below_cents >= 0 AND typeof(auto_accept_below_cents) = 'integer'),
  min_win_prob_auto_accept REAL NOT NULL DEFAULT 0.35 CHECK (
    min_win_prob_auto_accept >= 0.0 AND min_win_prob_auto_accept <= 1.0
  ),
  default_ops_cost_cents INTEGER NOT NULL DEFAULT 500 CHECK (default_ops_cost_cents >= 0 AND typeof(default_ops_cost_cents) = 'integer'),
  sla_buffer_hours INTEGER NOT NULL DEFAULT 4 CHECK (sla_buffer_hours >= 1),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
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

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY NOT NULL,
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

-- Triggers
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

CREATE TRIGGER IF NOT EXISTS trg_orders_check_dispute_amount_update
BEFORE UPDATE OF amount_cents ON orders
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.amount_cents < (SELECT COALESCE(MAX(dispute_amount_cents), 0) FROM disputes WHERE order_id = OLD.id)
    THEN RAISE(ABORT, 'BR-001: order amount_cents cannot be reduced below existing dispute_amount_cents')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_disputes_immutable_terminal_states
BEFORE UPDATE ON disputes
FOR EACH ROW
WHEN OLD.status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'BR-005: Cannot modify dispute in terminal state (WON, LOST, SETTLED_VIA_REFUND, EXPIRED)');
END;

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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_merchants_mode ON merchants(paypal_mode);
CREATE INDEX IF NOT EXISTS idx_orders_merchant_id ON orders(merchant_id);
CREATE INDEX IF NOT EXISTS idx_orders_paypal_id ON orders(paypal_order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_merchant_status_due ON disputes(merchant_id, status, seller_response_due_at);
CREATE INDEX IF NOT EXISTS idx_disputes_status_merchant ON disputes(status, merchant_id);
CREATE INDEX IF NOT EXISTS idx_disputes_order_id ON disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_paypal_id ON disputes(paypal_dispute_id);
CREATE INDEX IF NOT EXISTS idx_evidence_dispute_type ON evidence_items(dispute_id, evidence_type);
CREATE INDEX IF NOT EXISTS idx_evidence_sha256 ON evidence_items(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_assessments_dispute_created ON ai_assessments(dispute_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_negotiation_dispute ON negotiation_sessions(dispute_id);
CREATE INDEX IF NOT EXISTS idx_settlement_dispute_status ON settlement_offers(dispute_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity_action ON audit_logs(entity_type, entity_id, action);
CREATE INDEX IF NOT EXISTS idx_webhooks_webhook_id ON webhook_events(webhook_id);
`;

/**
 * Creates an in-memory or file-backed SQLite database instance.
 */
export function createTestDb(dbPath: string = ':memory:'): SqliteDbAdapter {
  try {
    // Attempt to require better-sqlite3 first
    const BetterSqlite = require('better-sqlite3');
    const bdb = new BetterSqlite(dbPath);
    bdb.pragma('foreign_keys = ON');
    bdb.exec(SCHEMA_SQL);
    return {
      exec: (sql: string) => bdb.exec(sql),
      prepare: (sql: string) => {
        const stmt = bdb.prepare(sql);
        return {
          run: (...params: any[]) => stmt.run(...params),
          get: (...params: any[]) => stmt.get(...params),
          all: (...params: any[]) => stmt.all(...params)
        };
      },
      close: () => bdb.close()
    };
  } catch (err) {
    // Fallback to Node 24 native node:sqlite
    const { DatabaseSync } = require('node:sqlite');
    const ndb = new DatabaseSync(dbPath);
    ndb.exec('PRAGMA foreign_keys = ON;');
    ndb.exec(SCHEMA_SQL);
    return {
      exec: (sql: string) => ndb.exec(sql),
      prepare: (sql: string) => {
        const stmt = ndb.prepare(sql);
        return {
          run: (...params: any[]) => stmt.run(...params),
          get: (...params: any[]) => stmt.get(...params),
          all: (...params: any[]) => stmt.all(...params)
        };
      },
      close: () => ndb.close()
    };
  }
}

/**
 * Seeds a test database with baseline Merchant and Policy Rule records.
 */
export function seedBaselineMerchant(db: SqliteDbAdapter, merchantId: string = 'merch_default') {
  db.prepare(`
    INSERT OR IGNORE INTO merchants (id, name, paypal_client_id, paypal_client_secret, paypal_mode, chargeback_fee_cents, currency)
    VALUES (?, 'Acme Electronics Corp', 'mock_client_id', 'mock_client_secret', 'SIMULATOR', 1500, 'USD')
  `).run(merchantId);

  db.prepare(`
    INSERT OR IGNORE INTO policy_rules (
      id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
      min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
      default_ops_cost_cents, sla_buffer_hours, is_active, version
    ) VALUES (
      ?, ?, 25000, 0.40, 0.75, 3500, 0.35, 500, 4, 1, 1
    )
  `).run(`pol_${merchantId}`, merchantId);
}

/**
 * Reconciles and computes the exact C-Suite KPIs directly from the SQLite database.
 */
export function calculateCSuiteKPIs(db: SqliteDbAdapter): CSuiteKPIReport {
  // KPI-001: Win Rate %
  const winRateRow = db.prepare(`
    SELECT 
      ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / 
            NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct,
      COUNT(*) AS total_disputes
    FROM disputes;
  `).get() as any;

  // KPI-002: Net Revenue Saved ($)
  const revenueRow = db.prepare(`
    SELECT 
      ROUND(SUM(
        CASE 
          WHEN d.status = 'WON' THEN d.dispute_amount_cents 
          WHEN d.status = 'SETTLED_VIA_REFUND' THEN (d.dispute_amount_cents - COALESCE(o.offered_amount_cents, d.dispute_amount_cents))
          ELSE 0 
        END
      ) / 100.0, 2) AS net_revenue_saved_dollars
    FROM disputes d
    LEFT JOIN settlement_offers o ON d.id = o.dispute_id AND o.status = 'ACCEPTED';
  `).get() as any;

  // KPI-003: Pre-Escalation Deflection Rate (%)
  const deflectionRow = db.prepare(`
    SELECT 
      ROUND(COUNT(CASE WHEN status = 'SETTLED_VIA_REFUND' THEN 1 END) * 100.0 / 
            NULLIF(COUNT(*), 0), 2) AS deflection_rate_pct
    FROM disputes;
  `).get() as any;

  // KPI-004: Chargeback Fee Avoidance ($) ($15.00 saved for every non-lost dispute)
  const feeRow = db.prepare(`
    SELECT 
      ROUND(COUNT(CASE WHEN status IN ('WON', 'SETTLED_VIA_REFUND') THEN 1 END) * 15.00, 2) AS fee_avoidance_dollars
    FROM disputes;
  `).get() as any;

  // KPI-005: Autonomous Resolution Rate (%)
  const autoRow = db.prepare(`
    SELECT 
      ROUND(COUNT(CASE WHEN status IN ('WON', 'SETTLED_VIA_REFUND') AND id NOT IN (
        SELECT entity_id FROM audit_logs WHERE actor_id = 'ACT-01' AND action = 'MANUAL_OVERRIDE'
      ) THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 2) AS autonomous_resolution_rate_pct
    FROM disputes;
  `).get() as any;

  // KPI-006: Mean Time to Evidence Submission (MTTES in seconds)
  const mttesRow = db.prepare(`
    SELECT 
      ROUND(AVG(strftime('%s', submitted_at) - strftime('%s', created_at)), 1) AS mttes_seconds
    FROM disputes
    WHERE status IN ('SUBMITTED', 'WON', 'LOST') AND submitted_at IS NOT NULL;
  `).get() as any;

  return {
    kpi_001_win_rate_pct: winRateRow?.win_rate_pct ?? 0,
    kpi_002_net_revenue_saved_dollars: revenueRow?.net_revenue_saved_dollars ?? 0,
    kpi_003_deflection_rate_pct: deflectionRow?.deflection_rate_pct ?? 0,
    kpi_004_fee_avoidance_dollars: feeRow?.fee_avoidance_dollars ?? 0,
    kpi_005_autonomous_resolution_rate_pct: autoRow?.autonomous_resolution_rate_pct ?? 0,
    kpi_006_mttes_seconds: mttesRow?.mttes_seconds ?? null,
    total_disputes: winRateRow?.total_disputes ?? 0
  };
}
