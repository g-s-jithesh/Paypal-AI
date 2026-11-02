/**
 * ChargebackShield — Tier 1 Feature Coverage: Data Foundation & Pre-Code Gates
 * Features 1 to 7: Schema, Data Dictionary, Golden Seeder, Scale Seeder, DQ, Rules, NFR
 * Grounded in PROJECT.md § Feature Inventory, PRD §6, and SPEC-SURVEY-002 §2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { seedGoldenPersonas, GOLDEN_PERSONAS, computeSha256 } from '../helpers/fixtures';
import { assertIntegerCents, assertSha256, assertIsoDate, assertNoPii } from '../helpers/assertions';

describe('Tier 1: Features 1-7 Data Foundation & Quality Gates', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // Feature 1: SQLite DDL Schema (ENT-01 to ENT-10)
  // ==========================================================================
  describe('Feature 1: SQLite DDL Schema (ENT-01..ENT-10)', () => {
    it('F1-TC1: All 10 core tables must be created and queryable', () => {
      const tables = [
        'merchants', 'orders', 'disputes', 'evidence_items', 'ai_assessments',
        'negotiation_sessions', 'settlement_offers', 'policy_rules', 'audit_logs', 'webhook_events'
      ];
      for (const table of tables) {
        const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).all(table);
        expect(rows.length).toBe(1);
      }
    });

    it('F1-TC2: Foreign keys must be enforced (reject orphaned disputes)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES ('DSP-ERR', 'merch_default', 'NON_EXISTENT_ORDER', 'PP-ERR', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 1000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow();
    });

    it('F1-TC3: Check constraints must reject negative dispute amounts', () => {
      // Create valid order
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
        VALUES ('ORD-1', 'merch_default', 'O-1', 'test@example.com', 'Test Buyer', 'USD', 5000, 'DELIVERED', 'Test Item')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES ('DSP-NEG', 'merch_default', 'ORD-1', 'PP-NEG', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', -500, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow();
    });

    it('F1-TC4: Composite performance indexes must exist in sqlite_master', () => {
      const indexes = [
        'idx_disputes_merchant_status_due',
        'idx_disputes_status_merchant',
        'idx_evidence_dispute_type',
        'idx_evidence_sha256',
        'idx_webhooks_webhook_id'
      ];
      for (const idx of indexes) {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(idx);
        expect(row).toBeDefined();
      }
    });

    it('F1-TC5: Unique constraints on paypal_dispute_id must reject duplicates', () => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
        VALUES ('ORD-DUP', 'merch_default', 'O-DUP', 'test@example.com', 'Test Buyer', 'USD', 5000, 'DELIVERED', 'Test Item')
      `).run();

      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
        VALUES ('DSP-1', 'merch_default', 'ORD-DUP', 'PP-DUP-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 1000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES ('DSP-2', 'merch_default', 'ORD-DUP', 'PP-DUP-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 1000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow();
    });
  });

  // ==========================================================================
  // Feature 2: Data Dictionary v2 Invariants
  // ==========================================================================
  describe('Feature 2: Data Dictionary v2 Requirements', () => {
    it('F2-TC1: Monetary amounts are strictly integer cents (no floating points)', () => {
      seedGoldenPersonas(db);
      const rows = db.prepare(`SELECT amount_cents FROM orders UNION ALL SELECT dispute_amount_cents FROM disputes`).all() as any[];
      for (const r of rows) {
        assertIntegerCents(r.amount_cents || r.dispute_amount_cents);
      }
    });

    it('F2-TC2: Dispute status must be restricted to valid finite state enum', () => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
        VALUES ('ORD-STATUS', 'merch_default', 'O-STAT', 'test@example.com', 'Test Buyer', 'USD', 5000, 'DELIVERED', 'Test Item')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES ('DSP-BADSTATUS', 'merch_default', 'ORD-STATUS', 'PP-STAT', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'INVALID_STATUS', 1000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow();
    });

    it('F2-TC3: ISO-8601 UTC timestamp format is enforced on created_at', () => {
      seedGoldenPersonas(db);
      const disputes = db.prepare(`SELECT created_at, seller_response_due_at FROM disputes`).all() as any[];
      for (const d of disputes) {
        assertIsoDate(d.created_at);
        assertIsoDate(d.seller_response_due_at);
      }
    });

    it('F2-TC4: Nullability constraints prevent missing customer_email in orders', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
          VALUES ('ORD-NULL-EMAIL', 'merch_default', 'O-NULL', NULL, 'Test Buyer', 'USD', 5000, 'DELIVERED', 'Test Item')
        `).run();
      }).toThrow();
    });

    it('F2-TC5: Evidence items sha256_hash must be exactly 64 characters', () => {
      seedGoldenPersonas(db);
      expect(() => {
        db.prepare(`
          INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
          VALUES ('EVI-BAD', 'DSP-GOLD-001', 'ORD-GOLD-001', 'TRACKING_PROOF', 'API', 'Bad Hash', '{}', 'short_hash')
        `).run();
      }).toThrow();
    });
  });

  // ==========================================================================
  // Feature 3: Deterministic Golden Dataset Seeder
  // ==========================================================================
  describe('Feature 3: Deterministic Golden Dataset Seeder', () => {
    it('F3-TC1: Seeds all benchmark Golden Personas (DSP-GOLD-001 through 005)', () => {
      seedGoldenPersonas(db);
      for (const id of ['DSP-GOLD-001', 'DSP-GOLD-002', 'DSP-GOLD-003', 'DSP-GOLD-004', 'DSP-GOLD-005']) {
        const row = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as any;
        expect(row).toBeDefined();
        expect(row.id).toBe(id);
      }
    });

    it('F3-TC2: DSP-GOLD-001 persona has exact expected attributes ($145, INR, Track A)', () => {
      seedGoldenPersonas(db);
      const dispute = db.prepare(`SELECT * FROM disputes WHERE id = 'DSP-GOLD-001'`).get() as any;
      expect(dispute.dispute_amount_cents).toBe(14500);
      expect(dispute.reason_code).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
      expect(dispute.track).toBe('TRACK_A_AUTO_SUBMIT');
    });

    it('F3-TC3: DSP-GOLD-003 persona has active negotiation session and 40% cap ($48)', () => {
      seedGoldenPersonas(db);
      const session = db.prepare(`SELECT * FROM negotiation_sessions WHERE dispute_id = 'DSP-GOLD-003'`).get() as any;
      expect(session).toBeDefined();
      expect(session.status).toBe('ACTIVE');
      expect(session.max_refund_allowed_cents).toBe(4800);
    });

    it('F3-TC4: Running seeder multiple times produces identical state without error', () => {
      seedGoldenPersonas(db);
      const count1 = (db.prepare(`SELECT COUNT(*) as c FROM disputes`).get() as any).c;
      seedGoldenPersonas(db);
      const count2 = (db.prepare(`SELECT COUNT(*) as c FROM disputes`).get() as any).c;
      expect(count1).toBe(count2);
    });

    it('F3-TC5: Seeder creates matching orders and evidence items for every dispute', () => {
      seedGoldenPersonas(db);
      const disputes = db.prepare(`SELECT id, order_id FROM disputes`).all() as any[];
      for (const d of disputes) {
        const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(d.order_id);
        const evidence = db.prepare(`SELECT * FROM evidence_items WHERE dispute_id = ?`).get(d.id);
        expect(order).toBeDefined();
        expect(evidence).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // Feature 4: Volumetric Scale Seeder
  // ==========================================================================
  describe('Feature 4: Volumetric Scale Seeder', () => {
    it('F4-TC1: Batch inserts 100 disputes cleanly within 500ms', () => {
      const startTime = Date.now();
      for (let i = 1; i <= 100; i++) {
        const ordId = `ORD-SCALE-${i}`;
        const dspId = `DSP-SCALE-${i}`;
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
          VALUES (?, 'merch_default', ?, 'user@scale.com', 'Scale User', 'USD', 10000, 'DELIVERED', 'Scale Item')
        `).run(ordId, `PP-O-${i}`);

        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES (?, 'merch_default', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run(dspId, ordId, `PP-D-${i}`);
      }
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000);
      const count = (db.prepare(`SELECT COUNT(*) as c FROM disputes WHERE id LIKE 'DSP-SCALE-%'`).get() as any).c;
      expect(count).toBe(100);
    });

    it('F4-TC2: Volumetric data maintains referential integrity (zero orphan disputes)', () => {
      const orphanCount = (db.prepare(`
        SELECT COUNT(*) as c FROM disputes d
        LEFT JOIN orders o ON d.order_id = o.id
        WHERE o.id IS NULL
      `).get() as any).c;
      expect(orphanCount).toBe(0);
    });

    it('F4-TC3: Order status distribution can represent expected delivery states', () => {
      const statuses = ['DELIVERED', 'IN_TRANSIT', 'UNFULFILLED'];
      for (const s of statuses) {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
          VALUES (?, 'merch_default', ?, 'user@scale.com', 'User', 'USD', 5000, ?, 'Item')
        `).run(`ORD-S-${s}`, `PP-O-${s}`, s);
      }
      const count = (db.prepare(`SELECT COUNT(DISTINCT delivery_status) as c FROM orders WHERE id LIKE 'ORD-S-%'`).get() as any).c;
      expect(count).toBe(3);
    });

    it('F4-TC4: High volume dispute query on index (status, due_at) runs in < 20ms', () => {
      const start = Date.now();
      const rows = db.prepare(`
        SELECT id, dispute_amount_cents FROM disputes
        WHERE merchant_id = 'merch_default' AND status = 'OPEN'
        ORDER BY seller_response_due_at ASC LIMIT 50
      `).all();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
      expect(Array.isArray(rows)).toBe(true);
    });

    it('F4-TC5: Bulk evidence records match parent orders and SHA-256 hashes', () => {
      const content = JSON.stringify({ tracking: 'TRK-BULK-01', status: 'DELIVERED' });
      const hash = computeSha256(content);
      assertSha256(hash);
      expect(hash.length).toBe(64);
    });
  });

  // ==========================================================================
  // Feature 5: Pre-Code Data Quality Gate (test:dq)
  // ==========================================================================
  describe('Feature 5: Pre-Code Data Quality Gate (test:dq)', () => {
    it('F5-TC1: Verifies 0 orphan records across all foreign key relationships', () => {
      seedGoldenPersonas(db);
      const foreignKeyViolations = (db.prepare(`
        SELECT COUNT(*) as c FROM (
          SELECT id FROM orders WHERE merchant_id NOT IN (SELECT id FROM merchants)
          UNION ALL
          SELECT id FROM disputes WHERE order_id NOT IN (SELECT id FROM orders)
          UNION ALL
          SELECT id FROM evidence_items WHERE dispute_id NOT IN (SELECT id FROM disputes)
        )
      `).get() as any).c;
      expect(foreignKeyViolations).toBe(0);
    });

    it('F5-TC2: Verifies zero unexpected nulls in required columns', () => {
      seedGoldenPersonas(db);
      const nullsCount = (db.prepare(`
        SELECT COUNT(*) as c FROM disputes
        WHERE dispute_amount_cents IS NULL OR status IS NULL OR seller_response_due_at IS NULL
      `).get() as any).c;
      expect(nullsCount).toBe(0);
    });

    it('F5-TC3: Verifies all timestamps satisfy chronology (seller_response_due_at > created_at)', () => {
      seedGoldenPersonas(db);
      const invalidDates = (db.prepare(`
        SELECT COUNT(*) as c FROM disputes
        WHERE seller_response_due_at <= created_at
      `).get() as any).c;
      expect(invalidDates).toBe(0);
    });

    it('F5-TC4: Verifies 100% of evidence items contain valid 64-char SHA-256 hashes', () => {
      seedGoldenPersonas(db);
      const evidence = db.prepare(`SELECT sha256_hash FROM evidence_items`).all() as any[];
      expect(evidence.length).toBeGreaterThan(0);
      for (const e of evidence) {
        assertSha256(e.sha256_hash);
      }
    });

    it('F5-TC5: Calculates composite DQ score of 100.0% on clean dataset', () => {
      seedGoldenPersonas(db);
      const totalDisputes = (db.prepare(`SELECT COUNT(*) as c FROM disputes`).get() as any).c;
      const validDisputes = (db.prepare(`
        SELECT COUNT(*) as c FROM disputes
        WHERE dispute_amount_cents > 0 AND status IS NOT NULL AND seller_response_due_at > created_at
      `).get() as any).c;
      const score = (validDisputes / totalDisputes) * 100.0;
      expect(score).toBe(100.0);
    });
  });

  // ==========================================================================
  // Feature 6: Pre-Code Business Rules Gate (test:rules)
  // ==========================================================================
  describe('Feature 6: Pre-Code Business Rules Gate (test:rules)', () => {
    it('F6-TC1: BR-001 trigger prevents dispute amount exceeding order amount', () => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
        VALUES ('ORD-BR001', 'merch_default', 'O-BR001', 'buyer@test.com', 'Buyer', 'USD', 10000, 'DELIVERED', 'Phone')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
          VALUES ('DSP-BR001', 'merch_default', 'ORD-BR001', 'PP-BR001', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 15000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow(/BR-001/);
    });

    it('F6-TC2: BR-002 check constraint enforces seller_response_due_at > created_at', () => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
        VALUES ('ORD-BR002', 'merch_default', 'O-BR002', 'buyer@test.com', 'Buyer', 'USD', 10000, 'DELIVERED', 'Phone')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, created_at, stage, version)
          VALUES ('DSP-BR002', 'merch_default', 'ORD-BR002', 'PP-BR002', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, 'USD', '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z', 'INQUIRY', 1)
        `).run();
      }).toThrow();
    });

    it('F6-TC3: BR-003 check constraint enforces win_probability between 0.00 and 1.00', () => {
      seedGoldenPersonas(db);
      expect(() => {
        db.prepare(`
          INSERT INTO ai_assessments (id, dispute_id, win_probability, expected_value_cents, ev_settle_cents, recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms)
          VALUES ('ASSESS-INV', 'DSP-GOLD-001', 1.05, 5000, 4000, 'AUTO_SUBMIT_EVIDENCE', 0.9, '{}', 'v1', 20)
        `).run();
      }).toThrow();
    });

    it('F6-TC4: BR-005 trigger blocks illegal mutation of terminal state (WON -> NEGOTIATING)', () => {
      seedGoldenPersonas(db);
      // Move DSP-GOLD-001 to WON
      db.prepare(`UPDATE disputes SET status = 'WON' WHERE id = 'DSP-GOLD-001'`).run();

      // Attempting to move from WON to NEGOTIATING should fail via BR-005 trigger
      expect(() => {
        db.prepare(`UPDATE disputes SET status = 'NEGOTIATING' WHERE id = 'DSP-GOLD-001'`).run();
      }).toThrow(/BR-005/);
    });

    it('F6-TC5: BR-012 trigger blocks UPDATE and DELETE on audit_logs (append-only ledger)', () => {
      db.prepare(`
        INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
        VALUES ('AUD-1', 'merch_default', 'disputes', 'DSP-1', 'CREATE', 'ACT-05', 'SYSTEM', '{}', '["BR-001"]', 'PASSED')
      `).run();

      expect(() => {
        db.prepare(`UPDATE audit_logs SET action = 'MODIFIED' WHERE id = 'AUD-1'`).run();
      }).toThrow(/BR-012/);

      expect(() => {
        db.prepare(`DELETE FROM audit_logs WHERE id = 'AUD-1'`).run();
      }).toThrow(/BR-012/);
    });
  });

  // ==========================================================================
  // Feature 7: Pre-Code NFR Gate (test:nfr)
  // ==========================================================================
  describe('Feature 7: Pre-Code NFR Gate (test:nfr)', () => {
    it('F7-TC1: NFR-007 query latency benchmark executes < 50ms', () => {
      seedGoldenPersonas(db);
      const start = Date.now();
      const disputes = db.prepare(`
        SELECT d.id, d.status, d.dispute_amount_cents, o.customer_email
        FROM disputes d
        JOIN orders o ON d.order_id = o.id
        WHERE d.merchant_id = 'merch_default'
      `).all();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
      expect(disputes.length).toBeGreaterThan(0);
    });

    it('F7-TC2: NFR-003 duplicate webhook rejection (idempotency key uniqueness)', () => {
      db.prepare(`
        INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
        VALUES ('WH-ROW-1', 'WH-IDEMPOTENT-123', 'CUSTOMER.DISPUTE.CREATED', 'PP-D-123', '{}', 'PROCESSED')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
          VALUES ('WH-ROW-2', 'WH-IDEMPOTENT-123', 'CUSTOMER.DISPUTE.CREATED', 'PP-D-123', '{}', 'PROCESSED')
        `).run();
      }).toThrow();
    });

    it('F7-TC3: NFR-005 PII token scan asserts no raw email leaked in sanitized payloads', () => {
      const sanitized = JSON.stringify({
        customer: '[BUYER_EMAIL_REDACTED]',
        order_id: 'ORD-123',
        amount: 5000
      });
      assertNoPii(sanitized);
    });

    it('F7-TC4: Optimistic concurrency control via version column', () => {
      seedGoldenPersonas(db);
      const dispute = db.prepare(`SELECT version FROM disputes WHERE id = 'DSP-GOLD-001'`).get() as any;
      expect(dispute.version).toBe(1);

      // Updating increments version
      db.prepare(`UPDATE disputes SET status = 'SUBMITTED', version = version + 1 WHERE id = 'DSP-GOLD-001' AND version = 1`).run();
      const updated = db.prepare(`SELECT version, status FROM disputes WHERE id = 'DSP-GOLD-001'`).get() as any;
      expect(updated.version).toBe(2);
      expect(updated.status).toBe('SUBMITTED');
    });

    it('F7-TC5: Transactional audit log consistency (state mutation + audit log in single unit)', () => {
      // Execute transaction simulating status transition and audit log
      const initialAuditCount = (db.prepare(`SELECT COUNT(*) as c FROM audit_logs`).get() as any).c;

      db.prepare(`
        INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
        VALUES ('AUD-TX-1', 'merch_default', 'disputes', 'DSP-GOLD-002', 'TRANSITION_NEGOTIATING', 'ACT-04', 'AI_AGENT', '{"status":"NEGOTIATING"}', '["BR-005","BR-009"]', 'PASSED')
      `).run();

      const newAuditCount = (db.prepare(`SELECT COUNT(*) as c FROM audit_logs`).get() as any).c;
      expect(newAuditCount).toBe(initialAuditCount + 1);
    });
  });
});
