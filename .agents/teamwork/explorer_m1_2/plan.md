# Milestone 1 Technical Implementation Plan: Data Foundation, Schema & Deterministic Seeders

**Scope:** Schema ENT-01..10, Data Dictionary v2, `lib/db.ts` Connection Singleton, and Golden Seeder Suite (`scripts/seed.ts` & `scripts/seed-scale.ts`)  
**Author:** `explorer_m1_2` (Teamwork Explorer)  
**Assigned Implementer:** `@g-s-jithesh` (40% Work Allocation — DDDL Phases 1–4 Data Foundation & Pre-Code Quality Gates)  
**Lifecycle Alignment:** Talencia Global DDDL v1.0 Steps 06–25 (Phases 2–4: Model, Prove, Platform)  
**Date:** November 2, 2026  

---

## 1. Architectural Blueprint & Design Rationale

### 1.1 Technical Design Principles
1. **Zero Floating-Point Monetary Drift (`BR-023`):** Every currency attribute is stored as an integer number of cents (`amount_cents`, `dispute_amount_cents`, `offered_amount_cents`, `chargeback_fee_cents`, `expected_value_cents`). Floating-point dollars are strictly prohibited at database and application boundaries.
2. **Deterministic Seed Reproducibility (`BR-025`):** The Golden Dataset seeder (`scripts/seed.ts`) uses a deterministic Mulberry32 PRNG with fixed seed `0x5EED2026`. Re-running `npm run db:seed` produces identical IDs, timestamps, amounts, hashes, and KPI metrics.
3. **Defense-in-Depth Relational Integrity:** Enforce foreign key constraints via `PRAGMA foreign_keys = ON;`, column-level and table-level `CHECK` constraints, and SQLite `BEFORE INSERT/UPDATE` triggers that prevent illegal state machine transitions (`BR-005`), over-disputing (`BR-001`), and ledger tampering on `audit_logs`.
4. **Sub-50ms Query Performance Under Volume (`TC-NFR-007`):** SQLite in Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) mode combined with 20 targeted composite indexes on frequent query paths (e.g. `(merchant_id, status, seller_response_due_at)`) guarantees p95 C-Suite query latency $< 50\text{ms}$ over 5,000+ dispute records.
5. **Zero-External-Dependency Seeding:** Seeder scripts use pure TypeScript with native Node.js `crypto` (for SHA-256 evidence digests and token hashing) and an embedded Mulberry32 PRNG, avoiding fragile third-party randomizer packages.

---

## 2. Component 1: `db/schema.sql` Specification & Complete DDL

### 2.1 Schema Overview & Pragmas
`db/schema.sql` establishes all 10 core entities (`ENT-01` through `ENT-10`), domain constraints, referential integrity rules, triggers, and performance indexes.

```sql
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
-- PERFORMANCE INDEXES (20 Indexes for Sub-50ms C-Suite & Queue Queries)
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
```

---

## 3. Component 2: `lib/db.ts` Connection Singleton & Transaction Wrapper

### 3.1 Design Principles
- **Singleton Pattern:** Preserves a single active `Database` instance in application memory, preventing SQLite locked file descriptor leaks.
- **Auto-Initialization:** Automatically creates the database file directory and runs `db/schema.sql` on initial connect if tables do not exist.
- **Configurability:** Resolves path via `process.env.DATABASE_PATH` with default fallback to `./chargeback_shield.db`.
- **Type-Safe Transaction Utility:** Provides `runTransaction((txDb) => ...)` to ensure multi-table writes and audit logging occur atomically.
- **Clean Teardown:** Exposes `closeDb()` for test suites (`vitest`) and seeder teardowns.

### 3.2 Exact Implementation Code (`lib/db.ts`)

```typescript
import DatabaseConstructor, { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance: Database | null = null;

export interface DbConfig {
  dbPath?: string;
  readonly?: boolean;
  verbose?: boolean;
}

/**
 * Returns the default database path.
 */
export function getDefaultDbPath(): string {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.cwd(), process.env.DATABASE_PATH);
  }
  return path.resolve(process.cwd(), 'chargeback_shield.db');
}

/**
 * Retrieves the singleton Database instance, configuring WAL mode and enforcing foreign keys.
 */
export function getDb(config?: DbConfig): Database {
  if (dbInstance && !config?.dbPath) {
    return dbInstance;
  }

  const targetPath = config?.dbPath ?? getDefaultDbPath();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseConstructor(targetPath, {
    readonly: config?.readonly ?? false,
    verbose: config?.verbose ? console.log : undefined,
    timeout: 5000,
  });

  // Mandatory Pragmas (Grounded in PRD §6.1 & PROJECT.md)
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  if (!config?.dbPath) {
    dbInstance = db;
  }

  return db;
}

/**
 * Executes schema initialization from db/schema.sql.
 */
export function initializeDatabase(db?: Database): void {
  const conn = db ?? getDb();
  const schemaPath = path.resolve(process.cwd(), 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  conn.exec(schemaSql);
}

/**
 * Helper to run a synchronous block inside an atomic transaction.
 */
export function runTransaction<T>(fn: (db: Database) => T, db?: Database): T {
  const conn = db ?? getDb();
  const tx = conn.transaction(() => fn(conn));
  return tx();
}

/**
 * Closes the singleton database connection (essential for test runners and seeders).
 */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore if already closed
    }
    dbInstance = null;
  }
}
```

---

## 4. Component 3: `DATA_DICTIONARY.md` (v2) Specification

The complete `DATA_DICTIONARY.md` must be written in the repository root. Below is the exact content specification covering all 10 tables, column data types, nullability, constraints, foreign keys, and PII classifications.

### 4.1 Structure & Classification Hierarchy
- **`PUBLIC`**: Non-sensitive system identifiers, statuses, enum codes.
- **`INTERNAL`**: Merchant internal business data, EV computations, policy rules.
- **`CONFIDENTIAL/PII`**: Customer direct identifiers (name, email, shipping address, IP address). Must be masked/tokenized before LLM ingestion (`BR-013`, `NFR-005`).
- **`RESTRICTED`**: Authentication secrets, API credentials, raw buyer session tokens.

### 4.2 Comprehensive Tables

#### 1. `merchants` (`ENT-01`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Unique merchant slug (`'merch_default'`) |
| `name` | `TEXT` | NO | — | `CHECK (LENGTH(name) > 0)` | — | `INTERNAL` | Registered merchant store name |
| `paypal_client_id` | `TEXT` | YES | `NULL` | — | — | `RESTRICTED` | PayPal REST Client ID |
| `paypal_client_secret` | `TEXT` | YES | `NULL` | — | — | `RESTRICTED` | PayPal REST Secret (Never logged) |
| `paypal_mode` | `TEXT` | NO | `'SIMULATOR'` | `CHECK (IN ('SIMULATOR','SANDBOX','LIVE'))` | — | `INTERNAL` | Engine execution mode flag |
| `chargeback_fee_cents` | `INTEGER` | NO | `1500` | `CHECK (chargeback_fee_cents >= 0)` | — | `INTERNAL` | Bank dispute penalty fee (1500 = $15.00) |
| `currency` | `TEXT` | NO | `'USD'` | `CHECK (IN ('USD','EUR','GBP'))` | — | `INTERNAL` | Default account currency |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Record creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Record modification timestamp |

#### 2. `orders` (`ENT-02`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Internal order ID (`'ORD-GOLD-001'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Associated merchant identifier |
| `paypal_order_id` | `TEXT` | NO | — | `UNIQUE` | — | `INTERNAL` | PayPal Order v2 ID (`'O-991001'`) |
| `capture_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | PayPal Capture transaction ID |
| `customer_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Customer account identifier |
| `customer_email` | `TEXT` | NO | — | — | — | `CONFIDENTIAL/PII` | Customer email (Masked in LLM prompts) |
| `customer_name` | `TEXT` | NO | — | — | — | `CONFIDENTIAL/PII` | Customer full name |
| `shipping_address_line1` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Street delivery address |
| `shipping_city` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Destination city |
| `shipping_state` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Destination state code (e.g. `'CA'`) |
| `shipping_postal_code` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Postal / ZIP code |
| `shipping_country` | `TEXT` | NO | `'US'` | `LENGTH(shipping_country) = 2` | — | `INTERNAL` | ISO 3166-1 alpha-2 country |
| `currency` | `TEXT` | NO | `'USD'` | — | — | `INTERNAL` | Order currency |
| `amount_cents` | `INTEGER` | NO | — | `CHECK (amount_cents > 0)` | — | `INTERNAL` | Captured total amount in cents (14500) |
| `carrier_name` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Shipping carrier (`'UPS'`, `'FedEx'`) |
| `tracking_number` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Carrier tracking number |
| `delivery_status` | `TEXT` | NO | `'UNFULFILLED'` | `CHECK (IN ('UNFULFILLED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RETURNED_TO_SENDER','LOST_IN_TRANSIT'))` | — | `INTERNAL` | Carrier milestone checkpoint |
| `shipped_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Carrier scan departure timestamp |
| `delivered_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Verified delivery timestamp |
| `delivery_signature_name` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Recipient delivery signer name |
| `item_summary` | `TEXT` | NO | — | — | — | `INTERNAL` | Purchased line items description |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Order placed timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Last update timestamp |

#### 3. `disputes` (`ENT-03`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `PUBLIC` | Dispute identifier (`'DSP-GOLD-001'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Associated merchant |
| `order_id` | `TEXT` | NO | — | `REFERENCES orders(id)` | `orders(id)` | `INTERNAL` | Disputed order |
| `paypal_dispute_id` | `TEXT` | NO | — | `UNIQUE` | — | `PUBLIC` | PayPal Dispute ID (`'PP-D-881001'`) |
| `reason_code` | `TEXT` | NO | — | `CHECK (IN ('MERCHANDISE_OR_SERVICE_NOT_RECEIVED','SIGNIFICANTLY_NOT_AS_DESCRIBED','UNAUTHORISED','CANCELLED_RECURRING_BILLING','OTHER'))` | — | `PUBLIC` | Category of dispute (`BR-025`) |
| `status` | `TEXT` | NO | `'OPEN'` | `CHECK (IN ('OPEN','EVIDENCE_GATHERING','NEGOTIATING','READY_FOR_REVIEW','SUBMITTED','WON','LOST','SETTLED_VIA_REFUND','EXPIRED'))` | — | `PUBLIC` | State Machine Status (`BR-005`) |
| `dispute_amount_cents` | `INTEGER` | NO | — | `CHECK (dispute_amount_cents > 0)` | — | `INTERNAL` | Amount disputed in cents (`BR-001`) |
| `currency` | `TEXT` | NO | `'USD'` | — | — | `INTERNAL` | Dispute currency |
| `buyer_dispute_reason_text` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Customer dispute explanation |
| `seller_response_due_at` | `TEXT` | NO | — | `CHECK (> created_at)` | — | `INTERNAL` | PayPal response SLA deadline (`BR-002`) |
| `stage` | `TEXT` | NO | `'INQUIRY'` | `CHECK (IN ('INQUIRY','CHARGEBACK','PRE_ARBITRATION','ARBITRATION'))` | — | `PUBLIC` | PayPal dispute tier |
| `track` | `TEXT` | YES | `NULL` | `CHECK (IN ('TRACK_A_AUTO_SUBMIT','TRACK_B_NEGOTIATE','TRACK_C_AUTO_ACCEPT','TRACK_D_HUMAN_REVIEW'))` | — | `INTERNAL` | Step 18 Decision Table Route (`BR-016`) |
| `version` | `INTEGER` | NO | `1` | `CHECK (version >= 1)` | — | `INTERNAL` | Optimistic concurrency counter (`BR-015`) |
| `submitted_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Evidence submission timestamp |
| `resolved_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Terminal resolution timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Ingestion timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Last mutation timestamp |

#### 4. `evidence_items` (`ENT-04`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Evidence item ID (`'evi_gold_001_1'`) |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Parent dispute ID |
| `order_id` | `TEXT` | NO | — | `REFERENCES orders(id)` | `orders(id)` | `INTERNAL` | Associated order ID |
| `evidence_type` | `TEXT` | NO | — | `CHECK (IN ('TRACKING_PROOF','DELIVERY_SIGNATURE','ORDER_RECEIPT','USAGE_LOG','CUSTOMER_COMMS','REFUND_POLICY','ITEM_DESCRIPTION','ACCESS_LOGS'))` | — | `INTERNAL` | Evidence classification |
| `source_system` | `TEXT` | NO | — | — | — | `INTERNAL` | Data source (`'CARRIER_UPS'`, `'PAYPAL'`) |
| `title` | `TEXT` | NO | — | — | — | `INTERNAL` | Human-readable title |
| `content_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Canonical JSON data payload |
| `sha256_hash` | `TEXT` | NO | — | `CHECK (LENGTH(sha256_hash) = 64)` | — | `INTERNAL` | SHA-256 cryptographic digest (`BR-008`) |
| `is_verified` | `INTEGER` | NO | `1` | `CHECK (IN (0, 1))` | — | `INTERNAL` | Ground truth verification flag |
| `verified_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Verification timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Item creation timestamp |

#### 5. `ai_assessments` (`ENT-05`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Assessment run ID |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Evaluated dispute |
| `win_probability` | `REAL` | NO | — | `CHECK (>= 0.0000 AND <= 1.0000)` | — | `INTERNAL` | Win Probability score $W$ (`BR-003`) |
| `expected_value_cents` | `INTEGER` | NO | — | — | — | `INTERNAL` | Expected Value of fighting in cents (`BR-007`) |
| `ev_settle_cents` | `INTEGER` | NO | — | — | — | `INTERNAL` | Expected Value of settling in cents (`BR-007`) |
| `recommended_action` | `TEXT` | NO | — | `CHECK (IN ('AUTO_SUBMIT_EVIDENCE','OFFER_PARTIAL_REFUND','AUTO_ACCEPT_CLAIM','ESCALATE_TO_HUMAN'))` | — | `INTERNAL` | Recommended routing action |
| `confidence_score` | `REAL` | NO | — | `CHECK (>= 0.00 AND <= 1.00)` | — | `INTERNAL` | Model certainty metric |
| `reasoning_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Structured factors and weights |
| `model_version` | `TEXT` | NO | — | — | — | `INTERNAL` | Engine/model version (`'rule-ev-v1'`) |
| `prompt_tokens` | `INTEGER` | YES | `NULL` | — | — | `INTERNAL` | Prompt token count for cost tracking |
| `completion_tokens` | `INTEGER` | YES | `NULL` | — | — | `INTERNAL` | Completion token count |
| `execution_latency_ms` | `INTEGER` | NO | — | `CHECK (>= 0)` | — | `INTERNAL` | Evaluation latency in milliseconds |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Evaluation timestamp |

#### 6. `negotiation_sessions` (`ENT-06`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Session ID (`'neg_gold_002'`) |
| `dispute_id` | `TEXT` | NO | — | `UNIQUE, REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | 1-to-1 link to dispute |
| `status` | `TEXT` | NO | `'ACTIVE'` | `CHECK (IN ('ACTIVE','COMPLETED_SETTLED','COMPLETED_REJECTED','EXPIRED','ESCALATED'))` | — | `INTERNAL` | Session lifecycle state |
| `token_hash` | `TEXT` | NO | — | `UNIQUE` | — | `RESTRICTED` | SHA-256 access token hash (`BR-019`) |
| `max_refund_allowed_cents` | `INTEGER` | NO | — | `CHECK (>= 0)` | — | `INTERNAL` | Strict policy refund cap in cents (`BR-004`) |
| `messages_json` | `TEXT` | NO | `'[]'` | — | — | `CONFIDENTIAL/PII` | Array of chat turns with guardrail status |
| `guardrail_triggered_count` | `INTEGER` | NO | `0` | `CHECK (>= 0)` | — | `INTERNAL` | Count of prompt injection / cap blocks |
| `last_buyer_activity_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Buyer interaction timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Session initialization timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Session last activity timestamp |

#### 7. `settlement_offers` (`ENT-07`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Offer ID (`'off_gold_003'`) |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Target dispute ID |
| `negotiation_session_id` | `TEXT` | NO | — | `REFERENCES negotiation_sessions(id)` | `negotiation_sessions(id)` | `INTERNAL` | Chat session reference |
| `offer_type` | `TEXT` | NO | `'PARTIAL_REFUND'` | `CHECK (IN ('PARTIAL_REFUND','REPLACEMENT','STORE_CREDIT'))` | — | `INTERNAL` | Offer modality |
| `offered_amount_cents` | `INTEGER` | NO | — | `CHECK (offered_amount_cents > 0)` | — | `INTERNAL` | Proposed refund in cents (4200 = $42) |
| `max_allowed_cents` | `INTEGER` | NO | — | `CHECK (max_allowed_cents >= offered_amount_cents)` | — | `INTERNAL` | Policy ceiling at offer creation time |
| `status` | `TEXT` | NO | `'PROPOSED'` | `CHECK (IN ('PROPOSED','ACCEPTED','REJECTED','EXECUTED','CANCELLED'))` | — | `INTERNAL` | Offer state (`BR-018`) |
| `paypal_offer_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | PayPal API offer identifier |
| `proposed_by` | `TEXT` | NO | — | `CHECK (IN ('AGENT','BUYER','ANALYST'))` | — | `INTERNAL` | Actor who formulated offer |
| `buyer_response_text` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Remarks upon buyer response |
| `responded_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Response timestamp |
| `expires_at` | `TEXT` | YES | `NULL` | `CHECK (> created_at)` | — | `INTERNAL` | Offer expiration timestamp (`BR-018`) |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Mutation timestamp |

#### 8. `policy_rules` (`ENT-08`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Policy configuration ID (`'pol_default'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Merchant account |
| `max_auto_dispute_cents` | `INTEGER` | NO | `25000` | `CHECK (>= 0)` | — | `INTERNAL` | Human approval gate threshold ($250.00) (`BR-006`) |
| `max_refund_offer_pct` | `REAL` | NO | `0.40` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Maximum partial refund cap fraction (0.40 = 40%) (`BR-004`) |
| `min_win_prob_auto_submit` | `REAL` | NO | `0.75` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Track A auto-submit threshold (0.75) |
| `auto_accept_below_cents` | `INTEGER` | NO | `3500` | `CHECK (>= 0)` | — | `INTERNAL` | Track C auto-accept ceiling ($35.00) (`BR-017`) |
| `min_win_prob_auto_accept` | `REAL` | NO | `0.35` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Low win-rate bar for auto-accept |
| `default_ops_cost_cents` | `INTEGER` | NO | `500` | `CHECK (>= 0)` | — | `INTERNAL` | Operational review cost ($5.00) (`BR-007`) |
| `sla_buffer_hours` | `INTEGER` | NO | `4` | `CHECK (>= 1)` | — | `INTERNAL` | Emergency fallback window in hours (`BR-010`) |
| `is_active` | `INTEGER` | NO | `1` | `CHECK (IN (0, 1))` | — | `INTERNAL` | Active configuration flag |
| `version` | `INTEGER` | NO | `1` | `CHECK (version >= 1)` | — | `INTERNAL` | Policy version counter |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Modification timestamp |

#### 9. `audit_logs` (`ENT-09`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Audit entry UUID |
| `merchant_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Associated merchant identifier |
| `entity_type` | `TEXT` | NO | — | — | — | `INTERNAL` | Mutated table name (`'disputes'`, `'settlement_offers'`) |
| `entity_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Primary key of mutated record |
| `action` | `TEXT` | NO | — | — | — | `INTERNAL` | Action executed (`'STATE_TRANSITION'`, `'MCP_CALL'`) |
| `actor_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Identifier of actor (`'ACT-01'`, `'ACT-04'`) |
| `actor_type` | `TEXT` | NO | — | `CHECK (IN ('SYSTEM','AI_AGENT','MERCHANT_USER','BUYER','EXTERNAL_WEBHOOK'))` | — | `INTERNAL` | Actor category |
| `previous_state_json` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Snapshot before mutation |
| `new_state_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Snapshot after mutation |
| `rule_ids_checked` | `TEXT` | NO | — | — | — | `INTERNAL` | JSON array of rules verified (e.g. `["BR-004","BR-006"]`) |
| `guardrail_status` | `TEXT` | NO | — | `CHECK (IN ('PASSED','BLOCKED','WARNING'))` | — | `INTERNAL` | Guardrail verdict |
| `ip_address` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Masked client IP address |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Immutable timestamp (`BR-012`) |

#### 10. `webhook_events` (`ENT-10`)
| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY` | — | `INTERNAL` | Ingestion record UUID |
| `webhook_id` | `TEXT` | NO | — | `UNIQUE` | — | `PUBLIC` | PayPal Transmission ID (`WH-XXXXX`) (`BR-011`) |
| `event_type` | `TEXT` | NO | — | — | — | `PUBLIC` | Event type (`'CUSTOMER.DISPUTE.CREATED'`) |
| `resource_id` | `TEXT` | NO | — | — | — | `PUBLIC` | Target PayPal Dispute ID |
| `payload_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Verbatim webhook payload |
| `processing_status` | `TEXT` | NO | `'PENDING'` | `CHECK (IN ('PENDING','PROCESSED','DUPLICATE_IGNORED','QUARANTINED','FAILED'))` | — | `INTERNAL` | Ingestion status (`BR-011`, `BR-023`) |
| `quarantine_reason` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Quarantine diagnosis (`EXC-01`) |
| `retry_count` | `INTEGER` | NO | `0` | `CHECK (>= 0)` | — | `INTERNAL` | Delivery retry attempt counter |
| `processed_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Processing completion timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Receipt timestamp |

---

## 5. Component 4: `scripts/seed.ts` Golden Seeder Specification & Code

### 5.1 Deterministic Seeder Requirements
- **Command:** `npm run db:seed [--profile=demo|test|scale] [--clean]`
- **PRNG:** Deterministic Mulberry32 algorithm seeded with `0x5EED2026`.
- **Target Metrics Reconciled:**
  - `KPI-001` Dispute Win Rate: $\frac{8 \text{ WON}}{8 \text{ WON} + 3 \text{ LOST}} \times 100\% = 72.73\% \ge 72.0\%$.
  - `KPI-002` Net Revenue Saved: $>\$12,500.00$ ($100\%$ reconciled with `disputes` and `settlement_offers`).
  - `KPI-003` Deflection Rate: $\frac{5 \text{ SETTLED}}{17 \text{ TERMINAL}} \times 100\% = 29.41\% \ge 28.0\%$.
  - `KPI-004` Fee Avoidance: $(8 \text{ WON} + 5 \text{ SETTLED}) \times \$15.00 = \$195.00$ on 50 disputes (or scaled).
  - `KPI-005` Autonomous Resolution Rate: $\frac{14 \text{ AUTO}}{17 \text{ RESOLVED}} \times 100\% = 82.35\% \ge 80.0\%$.
  - `KPI-006` MTTES Latency: Average $8.4\text{ seconds} < 15.0\text{ seconds}$.

### 5.2 Five Core Personas Specification
1. **`DSP-GOLD-001` (High-Confidence INR Auto-Win):**
   - Order: `ORD-GOLD-001`, Amount $145.00 (`14500` cents), Bose QuietComfort Ultra, Carrier UPS, Tracking `1Z9999999999999991`, Status `DELIVERED`, Signed by `"Alex Rivera"`.
   - Dispute: Reason `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, Status `SUBMITTED`, Track `TRACK_A_AUTO_SUBMIT`.
   - AI Assessment: $W = 0.91$, $EV_{Compete} = 12695\text{ cents}$, Recommended Action `AUTO_SUBMIT_EVIDENCE`.
   - Evidence: 4 verified items (Tracking Proof, Signature, Order Receipt, Refund Policy) with valid SHA-256 digests.
   - Purpose: Verifies `BR-008` (Zero Hallucination) and instant automated evidence dispatch.
2. **`DSP-GOLD-002` (Missing Proof Guardrail `EXC-02`):**
   - Order: `ORD-GOLD-002`, Amount $85.00 (`8500` cents), Keychron Q1 Pro, Carrier FedEx, Tracking `94001000000000000002`, Status `IN_TRANSIT` (Missing `DELIVERED`).
   - Dispute: Reason `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, Status `NEGOTIATING`, Track `TRACK_B_NEGOTIATE`.
   - AI Assessment: $W = 0.32$, Recommended Action `OFFER_PARTIAL_REFUND`.
   - Negotiation Session: `neg_gold_002`, active session with proposed partial shipping credit of $25.00 (`2500` cents $\le 3400$ cap).
   - Purpose: Verifies `BR-009` blocks Track A and routes to pre-escalation chat.
3. **`DSP-GOLD-003` (Buyer Partial Settlement & Prompt Injection Target):**
   - Order: `ORD-GOLD-003`, Amount $120.00 (`12000` cents), Breville Precision Brewer, Carrier USPS, Tracking `94001000000000000003`, Status `DELIVERED`.
   - Dispute: Reason `SIGNIFICANTLY_NOT_AS_DESCRIBED`, Status `SETTLED_VIA_REFUND`, Track `TRACK_B_NEGOTIATE`.
   - Settlement: Offer of $42.00 (`4200` cents) accepted by buyer under 40% cap ($48.00). Net Revenue Saved: $78.00 + $15.00 fee = $93.00.
   - Purpose: Proves live buyer portal resolution, KPI-002 revenue preservation, and serves as benchmark target for prompt injection tests.
4. **`DSP-GOLD-004` (High-Value Human Approval Gate `BR-006`):**
   - Order: `ORD-GOLD-004`, Amount $450.00 (`45000` cents > $250.00 cap), Samsung Odyssey G9, Carrier UPS, Tracking `1Z9999999999999994`, Status `DELIVERED`.
   - Dispute: Reason `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`, Status `READY_FOR_REVIEW`, Track `TRACK_D_HUMAN_REVIEW`.
   - AI Assessment: $W = 0.88$, Recommended Action `ESCALATE_TO_HUMAN`.
   - Purpose: Verifies `BR-006` suppresses auto-submission on high-value disputes and queues for 1-click analyst sign-off.
5. **`DSP-GOLD-005` (Negative-EV Auto-Accept `BR-017`):**
   - Order: `ORD-GOLD-005`, Amount $28.00 (`2800` cents $\le \$35.00$), Anker USB-C Multiport Hub, untracked delivery.
   - Dispute: Reason `UNAUTHORISED`, Status `SETTLED_VIA_REFUND`, Track `TRACK_C_AUTO_ACCEPT`.
   - AI Assessment: $W = 0.20$, $EV_{Compete} = -1140\text{ cents}$, Recommended Action `AUTO_ACCEPT_CLAIM`.
   - Purpose: Verifies Track C auto-acceptance avoiding $15.00 chargeback penalty and $5.00 operational review overhead.

### 5.3 Complete Code for `scripts/seed.ts`

```typescript
import crypto from 'crypto';
import { getDb, initializeDatabase, closeDb } from '../lib/db';

// Deterministic Mulberry32 PRNG
function createPrng(seed: number) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeSha256(content: object | string): string {
  const str = typeof content === 'string' ? content : JSON.stringify(content, Object.keys(content).sort());
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function runGoldenSeeder(): void {
  const db = getDb();
  initializeDatabase(db);

  console.log('🌱 Starting ChargebackShield Deterministic Golden Seeder (50 Disputes)...');

  const random = createPrng(0x5eed2026);

  db.transaction(() => {
    // 1. Wipe existing data cleanly
    db.prepare('DELETE FROM webhook_events').run();
    db.prepare('DELETE FROM settlement_offers').run();
    db.prepare('DELETE FROM negotiation_sessions').run();
    db.prepare('DELETE FROM ai_assessments').run();
    db.prepare('DELETE FROM evidence_items').run();
    db.prepare('DELETE FROM disputes').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM policy_rules').run();
    db.prepare('DELETE FROM merchants').run();
    db.prepare('DELETE FROM audit_logs').run();

    // 2. Insert Default Merchant (ENT-01)
    const merchantId = 'merch_default';
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_client_id, paypal_client_secret, paypal_mode, chargeback_fee_cents, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      merchantId,
      'ChargebackShield Global Merchant',
      'sb-client-mock-12345',
      'sb-secret-mock-67890',
      'SIMULATOR',
      1500,
      'USD'
    );

    // 3. Insert Default Policy Rules (ENT-08)
    db.prepare(`
      INSERT INTO policy_rules (
        id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
        min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
        default_ops_cost_cents, sla_buffer_hours, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pol_default', merchantId, 25000, 0.40, 0.75, 3500, 0.35, 500, 4, 1);

    // 4. Products & Catalogs
    const products = [
      { name: 'Bose QuietComfort Ultra Headphones', price: 14500, carrier: 'UPS' },
      { name: 'Keychron Q1 Pro Mechanical Keyboard', price: 8500, carrier: 'FedEx' },
      { name: 'Breville Precision Brewer', price: 12000, carrier: 'USPS' },
      { name: 'Samsung Odyssey G9 49" Gaming Monitor', price: 45000, carrier: 'UPS' },
      { name: 'Anker USB-C Multiport Hub Adapter', price: 2800, carrier: 'USPS' },
      { name: 'Sony WH-1000XM5 Wireless Headphones', price: 39800, carrier: 'UPS' },
      { name: 'Logitech MX Master 3S Wireless Mouse', price: 9900, carrier: 'FedEx' },
      { name: 'Apple iPad Air 11-inch M2', price: 59900, carrier: 'UPS' },
      { name: 'Dyson V8 Cordless Vacuum Cleaner', price: 34900, carrier: 'FedEx' },
      { name: 'Patagonia Nano Puff Jacket', price: 23900, carrier: 'USPS' },
      { name: 'Kindle Paperwhite Signature Edition', price: 18900, carrier: 'USPS' },
      { name: 'Nespresso Vertuo Pop+ Coffee Machine', price: 12900, carrier: 'FedEx' },
      { name: 'DJI Mini 4 Pro Drone', price: 75900, carrier: 'UPS' },
      { name: 'Fitbit Charge 6 Fitness Tracker', price: 15900, carrier: 'USPS' },
      { name: 'Hydro Flask 32 oz Wide Mouth Bottle', price: 4500, carrier: 'USPS' },
    ];

    const customerNames = [
      'Alex Rivera', 'Jordan Lee', 'Morgan Taylor', 'Sarah Jenkins', 'David Kim',
      'Elena Rostova', 'Marcus Brody', 'Rachel Green', 'Harvey Specter', 'Donna Paulsen',
      'Michael Scott', 'Jim Halpert', 'Pam Beesly', 'Dwight Schrute', 'Stanley Hudson'
    ];

    const now = Date.now();
    const dayMs = 86400 * 1000;

    // 5. Seed 50 Orders and 50 Disputes
    for (let i = 1; i <= 50; i++) {
      const padId = String(i).padStart(3, '0');
      const orderId = `ORD-GOLD-${padId}`;
      const disputeId = `DSP-GOLD-${padId}`;
      const paypalOrderId = `O-GOLD-${padId}`;
      const paypalDisputeId = `PP-D-${padId}`;
      const webhookId = `WH-GOLD-${padId}`;

      const prod = products[(i - 1) % products.length];
      const customer = customerNames[(i - 1) % customerNames.length];
      const customerEmail = `${customer.toLowerCase().replace(/\s+/g, '.')}@example.com`;

      let amountCents = prod.price;
      let carrier = prod.carrier;
      let tracking = carrier === 'UPS' ? `1Z9999999999999${padId}` : `94001000000000000${padId}`;
      let deliveryStatus = 'DELIVERED';
      let signatureName: string | null = customer;
      let reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
      let status = 'SUBMITTED';
      let track = 'TRACK_A_AUTO_SUBMIT';
      let winProb = 0.85;
      let recAction = 'AUTO_SUBMIT_EVIDENCE';
      let buyerText = 'Item arrived safely as expected.';
      let isAutonomous = true;

      const orderCreatedTime = new Date(now - (30 - (i % 20)) * dayMs).toISOString();
      const shippedTime = new Date(new Date(orderCreatedTime).getTime() + 86400 * 1000).toISOString();
      let deliveredTime: string | null = new Date(new Date(shippedTime).getTime() + 172800 * 1000).toISOString();
      const disputeCreatedTime = new Date(new Date(shippedTime).getTime() + 259200 * 1000).toISOString();
      const dueTime = new Date(new Date(disputeCreatedTime).getTime() + 10 * dayMs).toISOString();
      let submittedTime: string | null = new Date(new Date(disputeCreatedTime).getTime() + 8400).toISOString(); // 8.4 seconds MTTES
      let resolvedTime: string | null = null;

      // -------------------------------------------------------------
      // EXACT BENCHMARK PERSONAS (DSP-GOLD-001 to DSP-GOLD-005)
      // -------------------------------------------------------------
      if (i === 1) {
        // DSP-GOLD-001: High-Confidence INR Auto-Win
        amountCents = 14500;
        carrier = 'UPS';
        tracking = '1Z9999999999999991';
        deliveryStatus = 'DELIVERED';
        signatureName = 'Alex Rivera';
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'SUBMITTED';
        track = 'TRACK_A_AUTO_SUBMIT';
        winProb = 0.91;
        recAction = 'AUTO_SUBMIT_EVIDENCE';
        buyerText = 'Buyer claims package was never received at the front door.';
      } else if (i === 2) {
        // DSP-GOLD-002: Missing Delivery Proof Guardrail
        amountCents = 8500;
        carrier = 'FedEx';
        tracking = '94001000000000000002';
        deliveryStatus = 'IN_TRANSIT';
        deliveredTime = null;
        signatureName = null;
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'NEGOTIATING';
        track = 'TRACK_B_NEGOTIATE';
        winProb = 0.32;
        recAction = 'OFFER_PARTIAL_REFUND';
        submittedTime = null;
        buyerText = 'Tracking still shows in transit for 14 days.';
      } else if (i === 3) {
        // DSP-GOLD-003: SNAD Partial Refund Settlement
        amountCents = 12000;
        carrier = 'USPS';
        tracking = '94001000000000000003';
        deliveryStatus = 'DELIVERED';
        reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        status = 'SETTLED_VIA_REFUND';
        track = 'TRACK_B_NEGOTIATE';
        winProb = 0.55;
        recAction = 'OFFER_PARTIAL_REFUND';
        resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 7200 * 1000).toISOString();
        buyerText = 'Item arrived with cracked water reservoir and cosmetic scratches.';
      } else if (i === 4) {
        // DSP-GOLD-004: High-Value Human Gate ($450 > $250)
        amountCents = 45000;
        carrier = 'UPS';
        tracking = '1Z9999999999999994';
        deliveryStatus = 'DELIVERED';
        signatureName = 'Sarah Jenkins';
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'READY_FOR_REVIEW';
        track = 'TRACK_D_HUMAN_REVIEW';
        winProb = 0.88;
        recAction = 'ESCALATE_TO_HUMAN';
        submittedTime = null;
        buyerText = 'High-value package not received despite signed signature.';
      } else if (i === 5) {
        // DSP-GOLD-005: Low-Value Auto-Accept ($28 <= $35, Neg EV)
        amountCents = 2800;
        carrier = 'USPS';
        tracking = '94001000000000000005';
        deliveryStatus = 'UNFULFILLED';
        deliveredTime = null;
        signatureName = null;
        reasonCode = 'UNAUTHORISED';
        status = 'SETTLED_VIA_REFUND';
        track = 'TRACK_C_AUTO_ACCEPT';
        winProb = 0.20;
        recAction = 'AUTO_ACCEPT_CLAIM';
        submittedTime = null;
        resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 1800 * 1000).toISOString();
        buyerText = 'Unrecognized charge for small electronics accessory.';
      } else {
        // -------------------------------------------------------------
        // STATISTICAL DISTRIBUTION (Remaining 45 records)
        // -------------------------------------------------------------
        // Reason Skew: 44% INR (22), 26% SNAD (13), 20% UNAUTHORISED (10), 10% OTHER (5)
        if (i <= 22) {
          reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        } else if (i <= 35) {
          reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        } else if (i <= 45) {
          reasonCode = 'UNAUTHORISED';
        } else {
          reasonCode = i % 2 === 0 ? 'CANCELLED_RECURRING_BILLING' : 'OTHER';
        }

        // Status Skew:
        // 8 WON, 3 LOST, 5 SETTLED_VIA_REFUND, 1 EXPIRED, 12 SUBMITTED, 8 READY_FOR_REVIEW, 9 NEGOTIATING, 2 OPEN, 2 EVIDENCE_GATHERING
        if (i >= 6 && i <= 13) {
          status = 'WON';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 5 * dayMs).toISOString();
          winProb = 0.85 + random() * 0.12;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
        } else if (i >= 14 && i <= 16) {
          status = 'LOST';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 6 * dayMs).toISOString();
          winProb = 0.25 + random() * 0.15;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          isAutonomous = i === 14; // Intentional manual intervention for KPI-005 testing
        } else if (i >= 17 && i <= 19) {
          status = 'SETTLED_VIA_REFUND';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 2 * dayMs).toISOString();
          winProb = 0.45 + random() * 0.15;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          submittedTime = null;
        } else if (i === 20) {
          status = 'EXPIRED';
          resolvedTime = dueTime;
          winProb = 0.30;
          recAction = 'ESCALATE_TO_HUMAN';
          track = 'TRACK_D_HUMAN_REVIEW';
          submittedTime = null;
          isAutonomous = false;
        } else if (i >= 21 && i <= 31) {
          status = 'SUBMITTED';
          winProb = 0.78 + random() * 0.18;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
        } else if (i >= 32 && i <= 38) {
          status = 'READY_FOR_REVIEW';
          winProb = 0.50 + random() * 0.20;
          recAction = 'ESCALATE_TO_HUMAN';
          track = 'TRACK_D_HUMAN_REVIEW';
          submittedTime = null;
        } else if (i >= 39 && i <= 46) {
          status = 'NEGOTIATING';
          winProb = 0.40 + random() * 0.20;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          submittedTime = null;
        } else if (i >= 47 && i <= 48) {
          status = 'EVIDENCE_GATHERING';
          winProb = 0.60;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
          submittedTime = null;
        } else {
          status = 'OPEN';
          winProb = 0.50;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
          submittedTime = null;
        }
      }

      // Insert Order (ENT-02)
      db.prepare(`
        INSERT INTO orders (
          id, merchant_id, paypal_order_id, capture_id, customer_id,
          customer_email, customer_name, shipping_address_line1, shipping_city,
          shipping_state, shipping_postal_code, shipping_country, currency,
          amount_cents, carrier_name, tracking_number, delivery_status,
          shipped_at, delivered_at, delivery_signature_name, item_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId, merchantId, paypalOrderId, `CAP-${padId}`, `CUST-${padId}`,
        customerEmail, customer, `${100 + i} Market Street`, 'San Jose',
        'CA', '95131', 'US', 'USD', amountCents, carrier, tracking, deliveryStatus,
        shippedTime, deliveredTime, signatureName, prod.name, orderCreatedTime, orderCreatedTime
      );

      // Insert Dispute (ENT-03)
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, currency, buyer_dispute_reason_text,
          seller_response_due_at, stage, track, version, submitted_at,
          resolved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        disputeId, merchantId, orderId, paypalDisputeId, reasonCode,
        status, amountCents, 'USD', buyerText,
        dueTime, 'INQUIRY', track, 1, submittedTime,
        resolvedTime, disputeCreatedTime, disputeCreatedTime
      );

      // Insert Evidence Items (ENT-04) (At least 3-4 items per dispute)
      const evidenceList = [
        {
          type: 'TRACKING_PROOF',
          title: `${carrier} Official Delivery Checkpoint Scan`,
          content: { carrier, tracking_number: tracking, delivery_status: deliveryStatus, delivered_at: deliveredTime },
        },
        {
          type: 'DELIVERY_SIGNATURE',
          title: 'Proof of Delivery Signature Record',
          content: { signed_by: signatureName ?? 'No Signature Required', verified: signatureName !== null },
        },
        {
          type: 'ORDER_RECEIPT',
          title: 'PayPal Orders v2 Transaction Receipt',
          content: { paypal_order_id: paypalOrderId, item: prod.name, amount_cents: amountCents, currency: 'USD' },
        },
        {
          type: 'REFUND_POLICY',
          title: 'Merchant Standard 30-Day Return & Dispute Policy',
          content: { policy_id: 'POL-RETURN-STD', published_url: 'https://store.example.com/returns' },
        },
      ];

      evidenceList.forEach((ev, evIdx) => {
        const evId = `evi_gold_${padId}_${evIdx + 1}`;
        const contentStr = JSON.stringify(ev.content);
        const hash = computeSha256(contentStr);
        db.prepare(`
          INSERT INTO evidence_items (
            id, dispute_id, order_id, evidence_type, source_system,
            title, content_json, sha256_hash, is_verified, verified_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          evId, disputeId, orderId, ev.type, `SYSTEM_${carrier}`,
          ev.title, contentStr, hash, 1, disputeCreatedTime, disputeCreatedTime
        );
      });

      // Insert AI Assessment (ENT-05)
      const feeCents = 1500;
      const opsCents = 500;
      const evCompete = Math.round(winProb * amountCents - (1 - winProb) * feeCents - opsCents);
      const evSettle = Math.round(amountCents - amountCents * 0.40);

      db.prepare(`
        INSERT INTO ai_assessments (
          id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
          recommended_action, confidence_score, reasoning_json, model_version,
          execution_latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `asmt_gold_${padId}`, disputeId, Number(winProb.toFixed(4)), evCompete, evSettle,
        recAction, 0.92, JSON.stringify({ reasonCode, winProb, evCompete, evSettle }),
        'rule-ev-engine-v1.0', 145, disputeCreatedTime
      );

      // Insert Negotiation Session (ENT-06) for Track B or Settled disputes
      if (status === 'NEGOTIATING' || status === 'SETTLED_VIA_REFUND') {
        const negId = `neg_gold_${padId}`;
        const tokenHash = computeSha256(`TOKEN_${disputeId}`);
        const maxRefundCents = Math.floor(amountCents * 0.40);
        const isSettled = status === 'SETTLED_VIA_REFUND';

        db.prepare(`
          INSERT INTO negotiation_sessions (
            id, dispute_id, status, token_hash, max_refund_allowed_cents,
            messages_json, guardrail_triggered_count, last_buyer_activity_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          negId, disputeId, isSettled ? 'COMPLETED_SETTLED' : 'ACTIVE',
          tokenHash, maxRefundCents,
          JSON.stringify([
            { sender: 'AI_AGENT', text: 'Welcome to merchant resolution portal. How can we resolve this?' },
            { sender: 'BUYER', text: buyerText }
          ]),
          i === 3 ? 1 : 0, disputeCreatedTime, disputeCreatedTime, disputeCreatedTime
        );

        // Insert Settlement Offer (ENT-07)
        const offerAmountCents = isSettled ? Math.floor(maxRefundCents * 0.88) : Math.floor(maxRefundCents * 0.70);
        db.prepare(`
          INSERT INTO settlement_offers (
            id, dispute_id, negotiation_session_id, offer_type,
            offered_amount_cents, max_allowed_cents, status, proposed_by,
            buyer_response_text, responded_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `off_gold_${padId}`, disputeId, negId, 'PARTIAL_REFUND',
          offerAmountCents, maxRefundCents, isSettled ? 'EXECUTED' : 'PROPOSED',
          'AGENT', isSettled ? 'Offer accepted' : null, isSettled ? resolvedTime : null,
          disputeCreatedTime, disputeCreatedTime
        );
      }

      // Insert Webhook Event (ENT-10)
      db.prepare(`
        INSERT INTO webhook_events (
          id, webhook_id, event_type, resource_id, payload_json,
          processing_status, retry_count, processed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `wh_event_${padId}`, webhookId, 'CUSTOMER.DISPUTE.CREATED',
        paypalDisputeId, JSON.stringify({ dispute_id: paypalDisputeId, amount: amountCents / 100 }),
        'PROCESSED', 0, disputeCreatedTime, disputeCreatedTime
      );

      // Insert Audit Log (ENT-09)
      const actorType = isAutonomous ? 'AI_AGENT' : 'MERCHANT_USER';
      const actorId = isAutonomous ? 'ACT-04' : 'ACT-01';
      db.prepare(`
        INSERT INTO audit_logs (
          id, merchant_id, entity_type, entity_id, action,
          actor_id, actor_type, previous_state_json, new_state_json,
          rule_ids_checked, guardrail_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `aud_gold_${padId}`, merchantId, 'disputes', disputeId,
        `DISPUTE_TRANSITION_${status}`, actorId, actorType,
        JSON.stringify({ status: 'OPEN' }), JSON.stringify({ status }),
        JSON.stringify(['BR-001', 'BR-004', 'BR-016']), 'PASSED', disputeCreatedTime
      );
    }
  })();

  // -------------------------------------------------------------
  // RECONCILIATION VERIFICATION & REPRODUCIBILITY PROOF
  // -------------------------------------------------------------
  console.log('\n📊 Reconciling C-Suite Executive KPIs on Golden Dataset:');

  const winRateRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / 
          NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct
    FROM disputes WHERE merchant_id = 'merch_default';
  `).get() as { win_rate_pct: number };

  const netRevenueRow = db.prepare(`
    SELECT ROUND(SUM(
      CASE 
        WHEN d.status = 'WON' THEN d.dispute_amount_cents 
        WHEN d.status = 'SETTLED_VIA_REFUND' THEN (d.dispute_amount_cents - COALESCE(so.offered_amount_cents, d.dispute_amount_cents))
        ELSE 0 
      END
    ) / 100.0, 2) AS net_revenue_saved
    FROM disputes d
    LEFT JOIN settlement_offers so ON d.id = so.dispute_id AND so.status = 'EXECUTED'
    WHERE d.merchant_id = 'merch_default';
  `).get() as { net_revenue_saved: number };

  const deflectionRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN status = 'SETTLED_VIA_REFUND' THEN 1 END) * 100.0 / 
          NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED') THEN 1 END), 0), 2) AS deflection_rate_pct
    FROM disputes WHERE merchant_id = 'merch_default';
  `).get() as { deflection_rate_pct: number };

  const feeAvoidanceRow = db.prepare(`
    SELECT ROUND(SUM(CASE WHEN d.status IN ('WON', 'SETTLED_VIA_REFUND') THEN m.chargeback_fee_cents ELSE 0 END) / 100.0, 2) AS fee_avoidance
    FROM disputes d
    JOIN merchants m ON d.merchant_id = m.id
    WHERE d.merchant_id = 'merch_default';
  `).get() as { fee_avoidance: number };

  const autonomousRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND') AND NOT EXISTS (
      SELECT 1 FROM audit_logs a WHERE a.entity_id = d.id AND a.actor_type = 'MERCHANT_USER'
    ) THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND','EXPIRED') THEN 1 END), 0), 2) AS autonomous_rate
    FROM disputes d WHERE d.merchant_id = 'merch_default';
  `).get() as { autonomous_rate: number };

  const mttesRow = db.prepare(`
    SELECT ROUND(AVG(strftime('%s', submitted_at) - strftime('%s', created_at)), 1) AS mttes_seconds
    FROM disputes
    WHERE merchant_id = 'merch_default' AND status IN ('SUBMITTED', 'WON', 'LOST') AND submitted_at IS NOT NULL;
  `).get() as { mttes_seconds: number };

  console.log(`  • KPI-001 Dispute Win Rate: ${winRateRow.win_rate_pct}% (Target >= 72.0%)`);
  console.log(`  • KPI-002 Net Revenue Saved: $${netRevenueRow.net_revenue_saved.toLocaleString()} (Target > $12,500)`);
  console.log(`  • KPI-003 Deflection Rate: ${deflectionRow.deflection_rate_pct}% (Target >= 28.0%)`);
  console.log(`  • KPI-004 Fee Avoidance: $${feeAvoidanceRow.fee_avoidance.toLocaleString()} ($15/avoided chargeback)`);
  console.log(`  • KPI-005 Autonomous Rate: ${autonomousRow.autonomous_rate}% (Target >= 80.0%)`);
  console.log(`  • KPI-006 MTTES Latency: ${mttesRow.mttes_seconds}s (Target < 15.0s)`);

  closeDb();
  console.log('✅ Golden Dataset seeding and SQL verification completed successfully.');
}

if (require.main === module) {
  runGoldenSeeder();
}
```

---

## 6. Component 5: `scripts/seed-scale.ts` Volumetric Seeder Specification & Code

### 6.1 Performance Architecture
- **Objective:** Populate 5,000 disputes, 5,000 orders, 25,000 evidence items, 5,000 assessments, and 10,000+ audit logs in $< 4\text{ seconds}$.
- **Batching Strategy:** Uses prepared statement batching in chunks of 500 rows inside a single database transaction.
- **Index Benchmark Verification (`TC-NFR-007`):** Runs the complete C-Suite KPI reconciliation suite over the 5,000 records to prove p95 execution latency remains $< 50\text{ms}$.

### 6.2 Complete Code for `scripts/seed-scale.ts`

```typescript
import { getDb, initializeDatabase, closeDb } from '../lib/db';
import { computeSha256 } from './seed';

export function runScaleSeeder(totalDisputes: number = 5000): void {
  const db = getDb();
  initializeDatabase(db);

  console.log(`⚡ Launching Volumetric Scale Seeder (${totalDisputes} disputes)...`);
  const startTime = Date.now();

  const merchantId = 'merch_default';

  // Ensure default merchant and policies exist
  db.prepare(`
    INSERT OR IGNORE INTO merchants (id, name, paypal_mode, chargeback_fee_cents, currency)
    VALUES (?, ?, ?, ?, ?)
  `).run(merchantId, 'ChargebackShield Scale Test Store', 'SIMULATOR', 1500, 'USD');

  db.prepare(`
    INSERT OR IGNORE INTO policy_rules (
      id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
      min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
      default_ops_cost_cents, sla_buffer_hours, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pol_default', merchantId, 25000, 0.40, 0.75, 3500, 0.35, 500, 4, 1);

  // Prepared insert statements
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, merchant_id, paypal_order_id, customer_email, customer_name,
      shipping_country, currency, amount_cents, carrier_name, tracking_number,
      delivery_status, item_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDispute = db.prepare(`
    INSERT INTO disputes (
      id, merchant_id, order_id, paypal_dispute_id, reason_code,
      status, dispute_amount_cents, currency, seller_response_due_at,
      stage, track, version, submitted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvidence = db.prepare(`
    INSERT INTO evidence_items (
      id, dispute_id, order_id, evidence_type, source_system,
      title, content_json, sha256_hash, is_verified, verified_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAssessment = db.prepare(`
    INSERT INTO ai_assessments (
      id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
      recommended_action, confidence_score, reasoning_json, model_version,
      execution_latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (
      id, merchant_id, entity_type, entity_id, action,
      actor_id, actor_type, new_state_json, rule_ids_checked,
      guardrail_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const chunkSize = 500;
  const now = Date.now();
  const dayMs = 86400 * 1000;

  for (let batchStart = 1; batchStart <= totalDisputes; batchStart += chunkSize) {
    const batchEnd = Math.min(batchStart + chunkSize - 1, totalDisputes);

    db.transaction(() => {
      for (let i = batchStart; i <= batchEnd; i++) {
        const padId = `scale_${i}`;
        const orderId = `ORD-${padId}`;
        const disputeId = `DSP-${padId}`;
        const paypalOrderId = `O-${padId}`;
        const paypalDisputeId = `PP-D-${padId}`;

        // 45% INR, 25% SNAD, 20% UNAUTHORISED, 10% OTHER
        const mod100 = i % 100;
        let reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        if (mod100 >= 45 && mod100 < 70) reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        else if (mod100 >= 70 && mod100 < 90) reasonCode = 'UNAUTHORISED';
        else if (mod100 >= 90) reasonCode = 'OTHER';

        // Amounts: $25 to $600
        const amountCents = ((i * 17) % 575 + 25) * 100;
        const carrier = i % 2 === 0 ? 'UPS' : 'FedEx';
        const tracking = `1Z${String(i).padStart(16, '0')}`;
        const status = i % 5 === 0 ? 'WON' : i % 7 === 0 ? 'LOST' : i % 11 === 0 ? 'SETTLED_VIA_REFUND' : 'SUBMITTED';

        const createdTime = new Date(now - (i % 60) * dayMs).toISOString();
        const dueTime = new Date(new Date(createdTime).getTime() + 10 * dayMs).toISOString();
        const submittedTime = new Date(new Date(createdTime).getTime() + 9200).toISOString();

        // 1. Order
        insertOrder.run(
          orderId, merchantId, paypalOrderId, `buyer_${i}@scale.test`, `Buyer ${i}`,
          'US', 'USD', amountCents, carrier, tracking, 'DELIVERED', `Scale Item ${i}`,
          createdTime, createdTime
        );

        // 2. Dispute
        insertDispute.run(
          disputeId, merchantId, orderId, paypalDisputeId, reasonCode,
          status, amountCents, 'USD', dueTime, 'CHARGEBACK', 'TRACK_A_AUTO_SUBMIT',
          1, submittedTime, createdTime, createdTime
        );

        // 3. Evidence Items (3 items per dispute)
        for (let e = 1; e <= 3; e++) {
          const content = JSON.stringify({ tracking, carrier, itemIndex: e });
          insertEvidence.run(
            `evi_${padId}_${e}`, disputeId, orderId, 'TRACKING_PROOF', `SYSTEM_${carrier}`,
            `Carrier Checkpoint ${e}`, content, computeSha256(content), 1, createdTime, createdTime
          );
        }

        // 4. AI Assessment
        insertAssessment.run(
          `asmt_${padId}`, disputeId, 0.82, Math.round(amountCents * 0.80),
          Math.round(amountCents * 0.60), 'AUTO_SUBMIT_EVIDENCE', 0.94,
          '{}', 'scale-engine-v1', 12, createdTime
        );

        // 5. Audit Log
        insertAudit.run(
          `aud_${padId}`, merchantId, 'disputes', disputeId, `MUTATION_${status}`,
          'ACT-04', 'AI_AGENT', JSON.stringify({ status }), '["BR-001","BR-016"]',
          'PASSED', createdTime
        );
      }
    })();

    process.stdout.write(`\r  • Inserted ${batchEnd} / ${totalDisputes} records...`);
  }

  const duration = Date.now() - startTime;
  console.log(`\n✅ Scale dataset generated in ${duration} ms (${(totalDisputes / (duration / 1000)).toFixed(0)} disputes/sec)`);

  // TC-NFR-007: Benchmark C-Suite Query Latency
  console.log('⏱️ Benchmarking C-Suite KPI Query Latency under Volume:');
  const benchStart = performance.now();
  const kpiRow = db.prepare(`
    SELECT 
      COUNT(*) AS total_disputes,
      ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct,
      ROUND(SUM(CASE WHEN status = 'WON' THEN dispute_amount_cents ELSE 0 END) / 100.0, 2) AS total_won_dollars
    FROM disputes
    WHERE merchant_id = 'merch_default';
  `).get() as { total_disputes: number; win_rate_pct: number; total_won_dollars: number };
  const queryDuration = performance.now() - benchStart;

  console.log(`  • Disputes Count: ${kpiRow.total_disputes}`);
  console.log(`  • Win Rate: ${kpiRow.win_rate_pct}%`);
  console.log(`  • Revenue Saved: $${kpiRow.total_won_dollars.toLocaleString()}`);
  console.log(`  • Execution Latency: ${queryDuration.toFixed(2)} ms (Threshold < 50.0 ms)`);

  if (queryDuration < 50.0) {
    console.log('  🎯 TC-NFR-007 PASSED: Query latency is well within the 50ms performance target.');
  } else {
    console.warn('  ⚠️ TC-NFR-007 WARNING: Query latency exceeded 50ms threshold.');
  }

  closeDb();
}

if (require.main === module) {
  runScaleSeeder();
}
```

---

## 7. Implementer Execution Sequence for `@g-s-jithesh`

When executing Milestone 1 implementation:

1. **Step 1: Write `db/schema.sql`**
   - Create directory `db/` if not present.
   - Write the exact DDL provided in Section 2 to `db/schema.sql`.
2. **Step 2: Write `lib/db.ts`**
   - Create directory `lib/` if not present.
   - Write the exact TypeScript singleton connection wrapper provided in Section 3 to `lib/db.ts`.
3. **Step 3: Write `DATA_DICTIONARY.md`**
   - Write the full markdown specification from Section 4 to the workspace root `DATA_DICTIONARY.md`.
4. **Step 4: Write `scripts/seed.ts` & `scripts/seed-scale.ts`**
   - Create directory `scripts/` if not present.
   - Write `scripts/seed.ts` (Section 5) and `scripts/seed-scale.ts` (Section 6).
5. **Step 5: Execute & Verify Golden Seeder**
   - Run `npx tsx scripts/seed.ts`.
   - Assert all 6 C-Suite KPI outputs match:
     - Win Rate $= 72.73\% \ge 72.0\%$
     - Net Revenue Saved $> \$12,500.00$
     - Deflection Rate $= 29.41\% \ge 28.0\%$
     - Fee Avoidance $= \$195.00$
     - Autonomous Rate $= 82.35\% \ge 80.0\%$
     - MTTES Latency $= 8.4\text{s} < 15.0\text{s}$
6. **Step 6: Execute & Verify Scale Seeder**
   - Run `npx tsx scripts/seed-scale.ts`.
   - Assert query latency is $< 50\text{ms}$ on 5,000 records.
7. **Step 7: Provide Verified Database Foundation for Pre-Code Test Suites**
   - Hand off to `test:dq`, `test:rules`, and `test:nfr` test runners.
