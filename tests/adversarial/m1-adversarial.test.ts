import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { createTestDb } from '../helpers/db-helper';
import { getDb, closeDb } from '../../lib/db';
import { runGoldenSeeder } from '../../scripts/seed';

describe('Tier 5 Adversarial Stress Testing: SQLite Data Foundation & Seeder Stability', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    // Baseline merchant and order for foreign key reference
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_client_id, paypal_client_secret, paypal_mode, chargeback_fee_cents, currency)
      VALUES ('merch_adv_01', 'Adversarial Test Merchant', 'client_1', 'secret_1', 'SIMULATOR', 1500, 'USD')
    `).run();

    db.prepare(`
      INSERT INTO orders (
        id, merchant_id, paypal_order_id, customer_email, customer_name,
        currency, amount_cents, delivery_status, item_summary
      ) VALUES (
        'ord_adv_01', 'merch_adv_01', 'PO-ADV-01', 'target@victim.org', 'Victim User',
        'USD', 10000, 'DELIVERED', 'Test Laptop'
      )
    `).run();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore if already closed
    }
  });

  // ==========================================================================
  // 1. NEGATIVE MONETARY AMOUNTS
  // ==========================================================================
  describe('Adversarial Test 1: Negative Monetary Amounts Injection', () => {
    it('TC-ADV-NEG-001: Rejects negative and zero orders.amount_cents', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
          VALUES ('ord_neg_1', 'merch_adv_01', 'PO-NEG-1', 'a@b.com', 'A', -5000, 'Item')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
          VALUES ('ord_neg_2', 'merch_adv_01', 'PO-NEG-2', 'a@b.com', 'A', 0, 'Item')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-NEG-002: Rejects negative and zero disputes.dispute_amount_cents', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('dsp_neg_1', 'merch_adv_01', 'ord_adv_01', 'PP-D-NEG-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', -100, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('dsp_neg_2', 'merch_adv_01', 'ord_adv_01', 'PP-D-NEG-2', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 0, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-NEG-003: Rejects negative merchants.chargeback_fee_cents', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO merchants (id, name, chargeback_fee_cents)
          VALUES ('merch_neg', 'Bad Fee Merchant', -1500)
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-NEG-004: Rejects negative settlement_offers.offered_amount_cents', () => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_adv_01', 'merch_adv_01', 'ord_adv_01', 'PP-D-ADV-01', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();

      db.prepare(`
        INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
        VALUES ('neg_adv_01', 'dsp_adv_01', 'token_hash_adv', 2000)
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, proposed_by)
          VALUES ('off_neg', 'dsp_adv_01', 'neg_adv_01', -500, 2000, 'AGENT')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-NEG-005: Rejects negative policy_rules monetary amounts', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO policy_rules (id, merchant_id, max_auto_dispute_cents)
          VALUES ('pol_neg_1', 'merch_adv_01', -1)
        `).run();
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO policy_rules (id, merchant_id, auto_accept_below_cents)
          VALUES ('pol_neg_2', 'merch_adv_01', -500)
        `).run();
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO policy_rules (id, merchant_id, default_ops_cost_cents)
          VALUES ('pol_neg_3', 'merch_adv_01', -100)
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });
  });

  // ==========================================================================
  // 2. ORPHAN FOREIGN KEYS INJECTION
  // ==========================================================================
  describe('Adversarial Test 2: Orphan Foreign Key Injections', () => {
    it('TC-ADV-FK-001: Rejects orders with non-existent merchant_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
          VALUES ('ord_orphan', 'ghost_merchant', 'PO-ORPHAN', 'x@y.z', 'Ghost', 1000, 'Ghost Item')
        `).run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('TC-ADV-FK-002: Rejects disputes with non-existent order_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('dsp_orphan', 'merch_adv_01', 'ghost_order', 'PP-ORPHAN', 'OTHER', 'OPEN', 1000, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('TC-ADV-FK-003: Rejects disputes with non-existent merchant_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('dsp_orphan_m', 'ghost_merchant', 'ord_adv_01', 'PP-ORPHAN-M', 'OTHER', 'OPEN', 1000, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('TC-ADV-FK-004: Rejects evidence_items with non-existent dispute_id or order_id', () => {
      const validHash = 'a'.repeat(64);
      expect(() => {
        db.prepare(`
          INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
          VALUES ('ev_orphan_d', 'ghost_dispute', 'ord_adv_01', 'TRACKING_PROOF', 'UPS', 'Title', '{}', ?)
        `).run(validHash);
      }).toThrow(/FOREIGN KEY constraint failed/);

      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_adv_01', 'merch_adv_01', 'ord_adv_01', 'PP-D-ADV-01', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
          VALUES ('ev_orphan_o', 'dsp_adv_01', 'ghost_order', 'TRACKING_PROOF', 'UPS', 'Title', '{}', ?)
        `).run(validHash);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('TC-ADV-FK-005: Rejects negotiation_sessions and settlement_offers with orphan parents', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
          VALUES ('neg_orphan', 'ghost_dispute', 'token_ghost', 2000)
        `).run();
      }).toThrow(/FOREIGN KEY constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, proposed_by)
          VALUES ('off_orphan', 'ghost_dispute', 'ghost_session', 500, 2000, 'AGENT')
        `).run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  // ==========================================================================
  // 3. NULL INJECTIONS INTO NON-NULLABLE COLUMNS & PRIMARY KEY AUDIT
  // ==========================================================================
  describe('Adversarial Test 3: NULL Injections into Non-Nullable Columns & PK Nullability', () => {
    it('TC-ADV-NULL-001: Rejects NULL in mandatory merchant fields and audits primary key nullability', () => {
      // name has NOT NULL constraint
      expect(() => {
        db.prepare(`INSERT INTO merchants (id, name) VALUES ('m_null_name', NULL)`).run();
      }).toThrow(/NOT NULL constraint failed/);

      // id primary key has NOT NULL constraint
      expect(() => {
        db.prepare(`INSERT INTO merchants (id, name) VALUES (NULL, 'Null ID Merchant')`).run();
      }).toThrow(/NOT NULL constraint failed/);

      // Audit id primary key nullability in SQLite schema:
      const tableInfo = db.prepare('PRAGMA table_info(merchants)').all() as Array<{ name: string; notnull: number; pk: number }>;
      const idCol = tableInfo.find(c => c.name === 'id');
      console.log(`[EMPIRICAL TEST RESULT] merchants.id notnull flag: ${idCol?.notnull}`);
      expect(idCol).toBeDefined();
      expect(idCol?.notnull).toBe(1);
    });

    it('TC-ADV-NULL-002: Rejects NULL in mandatory order fields', () => {
      const requiredFields = [
        'merchant_id', 'paypal_order_id', 'customer_email', 'customer_name',
        'shipping_country', 'currency', 'amount_cents', 'delivery_status', 'item_summary'
      ];

      for (const field of requiredFields) {
        const base: Record<string, any> = {
          id: `ord_null_${field}`,
          merchant_id: 'merch_adv_01',
          paypal_order_id: `PO-NULL-${field}`,
          customer_email: 'test@null.com',
          customer_name: 'Null Tester',
          shipping_country: 'US',
          currency: 'USD',
          amount_cents: 5000,
          delivery_status: 'DELIVERED',
          item_summary: 'Test Item'
        };
        base[field] = null;

        expect(() => {
          db.prepare(`
            INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, shipping_country, currency, amount_cents, delivery_status, item_summary)
            VALUES (@id, @merchant_id, @paypal_order_id, @customer_email, @customer_name, @shipping_country, @currency, @amount_cents, @delivery_status, @item_summary)
          `).run(base);
        }).toThrow(/NOT NULL constraint failed/);
      }
    });

    it('TC-ADV-NULL-003: Rejects NULL in mandatory dispute fields', () => {
      const requiredFields = [
        'merchant_id', 'order_id', 'paypal_dispute_id', 'reason_code',
        'status', 'dispute_amount_cents', 'currency', 'seller_response_due_at', 'stage', 'version'
      ];

      for (const field of requiredFields) {
        const base: Record<string, any> = {
          id: `dsp_null_${field}`,
          merchant_id: 'merch_adv_01',
          order_id: 'ord_adv_01',
          paypal_dispute_id: `PP-D-NULL-${field}`,
          reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          status: 'OPEN',
          dispute_amount_cents: 5000,
          currency: 'USD',
          seller_response_due_at: '2026-11-20T00:00:00Z',
          stage: 'INQUIRY',
          version: 1
        };
        base[field] = null;

        expect(() => {
          db.prepare(`
            INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
            VALUES (@id, @merchant_id, @order_id, @paypal_dispute_id, @reason_code, @status, @dispute_amount_cents, @currency, @seller_response_due_at, @stage, @version)
          `).run(base);
        }).toThrow(/NOT NULL constraint failed/);
      }
    });

    it('TC-ADV-NULL-004: Audits notnull constraint flags across all 10 core tables primary keys', () => {
      const tables = [
        'merchants', 'orders', 'disputes', 'evidence_items', 'ai_assessments',
        'negotiation_sessions', 'settlement_offers', 'policy_rules', 'audit_logs', 'webhook_events'
      ];

      const pkNotnullReport: Record<string, number> = {};
      for (const t of tables) {
        const info = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; pk: number }>;
        const idCol = info.find(c => c.name === 'id');
        pkNotnullReport[t] = idCol?.notnull ?? -1;
        expect(idCol?.notnull).toBe(1);
      }

      console.log('[EMPIRICAL TEST RESULT] Primary Key notnull flags:', JSON.stringify(pkNotnullReport, null, 2));
      expect(Object.keys(pkNotnullReport).length).toBe(10);
    });
  });

  // ==========================================================================
  // 4. INVALID ENUM STRINGS INJECTION
  // ==========================================================================
  describe('Adversarial Test 4: Invalid Enum Strings Injection', () => {
    it('TC-ADV-ENUM-001: Rejects illegal merchants.paypal_mode and currency', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO merchants (id, name, paypal_mode)
          VALUES ('m_enum_1', 'Mode Test', 'PRODUCTION_UNTESTED')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      expect(() => {
        db.prepare(`
          INSERT INTO merchants (id, name, currency)
          VALUES ('m_enum_2', 'Currency Test', 'BITCOIN')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-ENUM-002: Rejects illegal orders.delivery_status', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, delivery_status, item_summary)
          VALUES ('ord_enum_1', 'merch_adv_01', 'PO-ENUM-1', 'a@b.com', 'A', 5000, 'MAGICALLY_TELEPORTED', 'Item')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-ENUM-003: Rejects illegal disputes status, reason_code, stage, and track', () => {
      // Invalid status
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('d_bad_status', 'merch_adv_01', 'ord_adv_01', 'PP-D-BS', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PENDING_HUMAN_TRIBUNAL', 5000, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      // Invalid reason code
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('d_bad_reason', 'merch_adv_01', 'ord_adv_01', 'PP-D-BR', 'BUYER_REMORSE_AFTER_DRINKING', 'OPEN', 5000, '2026-11-20T00:00:00Z')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      // Invalid stage
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at, stage)
          VALUES ('d_bad_stage', 'merch_adv_01', 'ord_adv_01', 'PP-D-BST', 'OTHER', 'OPEN', 5000, '2026-11-20T00:00:00Z', 'SUPREME_COURT')
        `).run();
      }).toThrow(/CHECK constraint failed/);

      // Invalid track
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at, track)
          VALUES ('d_bad_track', 'merch_adv_01', 'ord_adv_01', 'PP-D-BTR', 'OTHER', 'OPEN', 5000, '2026-11-20T00:00:00Z', 'TRACK_Z_CHAOS')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-ENUM-004: Rejects illegal evidence_items.evidence_type', () => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_adv_01', 'merch_adv_01', 'ord_adv_01', 'PP-D-ADV-01', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash)
          VALUES ('ev_bad_type', 'dsp_adv_01', 'ord_adv_01', 'UNVERIFIED_RUMOR', 'UPS', 'Title', '{}', '${'a'.repeat(64)}')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });

    it('TC-ADV-ENUM-005: Rejects illegal ai_assessments.recommended_action', () => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_adv_01', 'merch_adv_01', 'ord_adv_01', 'PP-D-ADV-01', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO ai_assessments (
            id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
            recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms
          ) VALUES (
            'asmt_bad_action', 'dsp_adv_01', 0.8, 1000, 500,
            'BRIBE_BUYER', 0.9, '{}', 'v1', 50
          )
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });
  });

  // ==========================================================================
  // 5. FLOATING-POINT CENTS INJECTION (EMPIRICAL FINDING)
  // ==========================================================================
  describe('Adversarial Test 5: Floating-Point Cents Injection', () => {
    it('TC-ADV-FLT-001: Probe SQLite rejection of float in amount_cents columns', () => {
      // Testing orders.amount_cents with 10.5
      let orderAcceptedFloat = false;
      try {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
          VALUES ('ord_flt_1', 'merch_adv_01', 'PO-FLT-1', 'flt@test.com', 'Float User', 10.5, 'Float Item')
        `).run();
        const row = db.prepare('SELECT amount_cents, typeof(amount_cents) as t FROM orders WHERE id = ?').get('ord_flt_1') as { amount_cents: number; t: string };
        orderAcceptedFloat = row.t === 'real' || row.amount_cents === 10.5;
      } catch {
        orderAcceptedFloat = false;
      }

      // Testing disputes.dispute_amount_cents with 49.99
      let disputeAcceptedFloat = false;
      try {
        db.prepare(`
          INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
          VALUES ('dsp_flt_1', 'merch_adv_01', 'ord_adv_01', 'PP-D-FLT-1', 'OTHER', 'OPEN', 49.99, '2026-11-20T00:00:00Z')
        `).run();
        const row = db.prepare('SELECT dispute_amount_cents, typeof(dispute_amount_cents) as t FROM disputes WHERE id = ?').get('dsp_flt_1') as { dispute_amount_cents: number; t: string };
        disputeAcceptedFloat = row.t === 'real' || row.dispute_amount_cents === 49.99;
      } catch {
        disputeAcceptedFloat = false;
      }

      console.log(`[EMPIRICAL TEST RESULT] orders.amount_cents accepted float 10.5: ${orderAcceptedFloat}`);
      console.log(`[EMPIRICAL TEST RESULT] disputes.dispute_amount_cents accepted float 49.99: ${disputeAcceptedFloat}`);

      expect(orderAcceptedFloat).toBe(false);
      expect(disputeAcceptedFloat).toBe(false);

      expect(() => {
        db.prepare(`
          INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
          VALUES ('ord_flt_err', 'merch_adv_01', 'PO-FLT-ERR', 'flt@test.com', 'Float User', 10.5, 'Float Item')
        `).run();
      }).toThrow(/CHECK constraint failed/);
    });
  });

  // ==========================================================================
  // 6. BUSINESS RULE TRIGGER INTEGRITY
  // ==========================================================================
  describe('Adversarial Test 6: Business Rule Trigger Mutability Probing', () => {
    it('TC-ADV-TRG-001: Verifies terminal state immutability trigger behavior', () => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_term_1', 'merch_adv_01', 'ord_adv_01', 'PP-D-TERM-1', 'OTHER', 'WON', 5000, '2026-11-20T00:00:00Z')
      `).run();

      // Changing status on terminal dispute throws
      expect(() => {
        db.prepare("UPDATE disputes SET status = 'LOST' WHERE id = 'dsp_term_1'").run();
      }).toThrow(/BR-005/);

      // Mutating non-status field on terminal dispute
      let nonStatusMutated = false;
      try {
        db.prepare("UPDATE disputes SET dispute_amount_cents = 8000 WHERE id = 'dsp_term_1'").run();
        const row = db.prepare("SELECT dispute_amount_cents FROM disputes WHERE id = 'dsp_term_1'").get() as { dispute_amount_cents: number };
        nonStatusMutated = row.dispute_amount_cents === 8000;
      } catch {
        nonStatusMutated = false;
      }

      console.log(`[EMPIRICAL TEST RESULT] Non-status mutation on terminal dispute allowed: ${nonStatusMutated}`);
      expect(nonStatusMutated).toBe(false);
    });

    it('TC-ADV-TRG-002: Verifies audit_logs append-only triggers prevent update and delete', () => {
      db.prepare(`
        INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
        VALUES ('aud_adv_1', 'merch_adv_01', 'disputes', 'd1', 'TEST', 'ACT-1', 'SYSTEM', '{}', '[]', 'PASSED')
      `).run();

      expect(() => {
        db.prepare("UPDATE audit_logs SET action = 'ALTERED' WHERE id = 'aud_adv_1'").run();
      }).toThrow(/BR-012/);

      expect(() => {
        db.prepare("DELETE FROM audit_logs WHERE id = 'aud_adv_1'").run();
      }).toThrow(/BR-012/);
    });

    it('TC-ADV-TRG-003: Verifies order amount_cents cannot be downgraded below dispute amount_cents (BR-001)', () => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp_order_check', 'merch_adv_01', 'ord_adv_01', 'PP-D-ORDCHK', 'OTHER', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();

      expect(() => {
        db.prepare("UPDATE orders SET amount_cents = 100 WHERE id = 'ord_adv_01'").run();
      }).toThrow(/BR-001: order amount_cents cannot be reduced below existing dispute_amount_cents/);
    });
  });

  // ==========================================================================
  // 7. DETERMINISTIC SEEDER STABILITY ACROSS RUNS
  // ==========================================================================
  describe('Adversarial Test 7: Deterministic Seeder Stability & Hash Audit', () => {
    function computeTableHashes(): Record<string, { count: number; hash: string }> {
      const diskDb = getDb();
      const tables = [
        'merchants', 'orders', 'disputes', 'evidence_items', 'ai_assessments',
        'negotiation_sessions', 'settlement_offers', 'policy_rules', 'audit_logs', 'webhook_events'
      ];
      const tableHashes: Record<string, { count: number; hash: string }> = {};

      for (const t of tables) {
        const rows = diskDb.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
        const hash = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        tableHashes[t] = { count: rows.length, hash };
      }
      closeDb();
      return tableHashes;
    }

    it('TC-ADV-SEED-001: Asserts row counts, table SHA-256 hashes, and KPI reconciliation across consecutive runs', () => {
      // Run 1
      runGoldenSeeder();
      const hashes1 = computeTableHashes();

      // Run 2
      runGoldenSeeder();
      const hashes2 = computeTableHashes();

      // Verify row counts across all 10 tables are 100% identical
      expect(hashes1.merchants.count).toBe(1);
      expect(hashes2.merchants.count).toBe(1);

      expect(hashes1.orders.count).toBe(50);
      expect(hashes2.orders.count).toBe(50);

      expect(hashes1.disputes.count).toBe(50);
      expect(hashes2.disputes.count).toBe(50);

      expect(hashes1.evidence_items.count).toBe(200);
      expect(hashes2.evidence_items.count).toBe(200);

      expect(hashes1.ai_assessments.count).toBe(50);
      expect(hashes2.ai_assessments.count).toBe(50);

      expect(hashes1.negotiation_sessions.count).toBe(14);
      expect(hashes2.negotiation_sessions.count).toBe(14);

      expect(hashes1.settlement_offers.count).toBe(14);
      expect(hashes2.settlement_offers.count).toBe(14);

      expect(hashes1.policy_rules.count).toBe(1);
      expect(hashes2.policy_rules.count).toBe(1);

      expect(hashes1.audit_logs.count).toBe(50);
      expect(hashes2.audit_logs.count).toBe(50);

      expect(hashes1.webhook_events.count).toBe(50);
      expect(hashes2.webhook_events.count).toBe(50);

      // Check table hash identity
      const mismatchedTables: string[] = [];
      for (const table of Object.keys(hashes1)) {
        if (hashes1[table].hash !== hashes2[table].hash) {
          mismatchedTables.push(table);
        }
      }

      console.log(`[EMPIRICAL TEST RESULT] Table Hash Audit: Mismatched tables count: ${mismatchedTables.length}`);
      if (mismatchedTables.length > 0) {
        console.log(`[EMPIRICAL TEST RESULT] Mismatched tables due to dynamic timestamps: ${mismatchedTables.join(', ')}`);
      }

      expect(mismatchedTables).toHaveLength(0);
      expect(mismatchedTables.length).toBe(0);
    });
  });
});
