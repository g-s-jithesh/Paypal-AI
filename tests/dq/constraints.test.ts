import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

describe('Data Quality: Constraints & Domain Integrity', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    // Insert base merchant for FK dependencies
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_mode, chargeback_fee_cents, currency)
      VALUES ('m1', 'Test Merchant', 'SIMULATOR', 1500, 'USD')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('TC-DQ-CST-001: NOT NULL constraint verification', () => {
    // Missing customer_email on orders throws
    expect(() => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
        VALUES ('o1', 'm1', 'PO-1', NULL, 'Buyer', 1000, 'Item')
      `).run();
    }).toThrow(/NOT NULL constraint failed/);

    // Missing amount_cents on orders throws
    expect(() => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
        VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', NULL, 'Item')
      `).run();
    }).toThrow(/NOT NULL constraint failed/);
  });

  it('TC-DQ-CST-002: Monetary positive bound checks', () => {
    // Order amount <= 0 throws
    expect(() => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
        VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 0, 'Item')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    expect(() => {
      db.prepare(`
        INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
        VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', -500, 'Item')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Valid positive amount succeeds
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    // Dispute amount <= 0 throws
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 0, '2026-11-20T00:00:00Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it('TC-DQ-CST-003: Probability and Percentage Bounds ([0.0, 1.0])', () => {
    // Setup valid order and dispute
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
    `).run();

    // win_probability > 1.0 throws
    expect(() => {
      db.prepare(`
        INSERT INTO ai_assessments (id, dispute_id, win_probability, expected_value_cents, ev_settle_cents, recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms)
        VALUES ('a1', 'd1', 1.05, 3000, 2000, 'AUTO_SUBMIT_EVIDENCE', 0.9, '{}', 'v1', 10)
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // win_probability < 0.0 throws
    expect(() => {
      db.prepare(`
        INSERT INTO ai_assessments (id, dispute_id, win_probability, expected_value_cents, ev_settle_cents, recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms)
        VALUES ('a1', 'd1', -0.01, 3000, 2000, 'AUTO_SUBMIT_EVIDENCE', 0.9, '{}', 'v1', 10)
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // max_refund_offer_pct > 1.0 throws
    expect(() => {
      db.prepare(`
        INSERT INTO policy_rules (id, merchant_id, max_refund_offer_pct)
        VALUES ('p1', 'm1', 1.5)
      `).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it('TC-DQ-CST-004: Enum Value Restrictions', () => {
    // Setup order
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    // Invalid status throws
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'INVALID_STATUS', 5000, '2026-11-20T00:00:00Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Invalid reason_code throws
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'SOME_UNKNOWN_FRAUD', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);
  });

  it('TC-DQ-CST-005: SHA-256 Digest Length Check (64 characters)', () => {
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
    `).run();

    // Short hash throws
    expect(() => {
      db.prepare(`
        INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
        VALUES ('e1', 'd1', 'o1', 'TRACKING_PROOF', 'UPS', 'Title', '{}', 'abc123short')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // Exact 64 hex characters succeeds
    const validHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(() => {
      db.prepare(`
        INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
        VALUES ('e1', 'd1', 'o1', 'TRACKING_PROOF', 'UPS', 'Title', '{}', ?)
      `).run(validHash);
    }).not.toThrow();
  });
});
