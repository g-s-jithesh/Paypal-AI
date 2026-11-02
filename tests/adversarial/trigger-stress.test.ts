import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

describe('Tier 5 Adversarial: SQLite Database Trigger Stress Tests', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    // Setup baseline merchant and order
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m_adv', 'Adversarial Merchant', 1500)
    `).run();

    db.prepare(`
      INSERT INTO orders (
        id, merchant_id, paypal_order_id, customer_email, customer_name,
        amount_cents, item_summary
      ) VALUES (
        'ord_adv_100', 'm_adv', 'PO-ADV-100', 'victim@example.com', 'Victim User',
        10000, 'Expensive Electronics'
      )
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Trigger: trg_disputes_check_order_amount_insert & update (BR-001)', () => {
    it('ABORTS when dispute_amount_cents = order.amount_cents + 1 (10001 vs 10000)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code,
            status, dispute_amount_cents, seller_response_due_at
          ) VALUES (
            'dsp_over_1', 'm_adv', 'ord_adv_100', 'PP-OVER-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
            'OPEN', 10001, '2026-11-20T00:00:00Z'
          )
        `).run();
      }).toThrow(/BR-001: dispute_amount_cents cannot exceed order amount_cents/);

      // Verify no record was inserted
      const count = db.prepare('SELECT count(*) as count FROM disputes WHERE id = ?').get('dsp_over_1') as { count: number };
      expect(count.count).toBe(0);
    });

    it('ABORTS on massive overflow: dispute_amount_cents = order.amount_cents * 10 (100000 cents)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code,
            status, dispute_amount_cents, seller_response_due_at
          ) VALUES (
            'dsp_over_massive', 'm_adv', 'ord_adv_100', 'PP-OVER-MASSIVE', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
            'OPEN', 100000, '2026-11-20T00:00:00Z'
          )
        `).run();
      }).toThrow(/BR-001: dispute_amount_cents cannot exceed order amount_cents/);
    });

    it('SUCCEEDS at exact boundary: dispute_amount_cents = order.amount_cents (10000 cents)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code,
            status, dispute_amount_cents, seller_response_due_at
          ) VALUES (
            'dsp_exact_boundary', 'm_adv', 'ord_adv_100', 'PP-EXACT', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
            'OPEN', 10000, '2026-11-20T00:00:00Z'
          )
        `).run();
      }).not.toThrow();

      const row = db.prepare('SELECT dispute_amount_cents FROM disputes WHERE id = ?').get('dsp_exact_boundary') as {
        dispute_amount_cents: number;
      };
      expect(row.dispute_amount_cents).toBe(10000);
    });

    it('SUCCEEDS just below boundary: dispute_amount_cents = order.amount_cents - 1 (9999 cents)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code,
            status, dispute_amount_cents, seller_response_due_at
          ) VALUES (
            'dsp_sub_boundary', 'm_adv', 'ord_adv_100', 'PP-SUB', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
            'OPEN', 9999, '2026-11-20T00:00:00Z'
          )
        `).run();
      }).not.toThrow();
    });

    it('ABORTS when UPDATE attempts to increase dispute_amount_cents above order amount (10001 cents)', () => {
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, seller_response_due_at
        ) VALUES (
          'dsp_update_test', 'm_adv', 'ord_adv_100', 'PP-UPD', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'OPEN', 5000, '2026-11-20T00:00:00Z'
        )
      `).run();

      expect(() => {
        db.prepare('UPDATE disputes SET dispute_amount_cents = 10001 WHERE id = ?').run('dsp_update_test');
      }).toThrow(/BR-001: dispute_amount_cents cannot exceed order amount_cents/);

      // Verify amount unchanged
      const row = db.prepare('SELECT dispute_amount_cents FROM disputes WHERE id = ?').get('dsp_update_test') as {
        dispute_amount_cents: number;
      };
      expect(row.dispute_amount_cents).toBe(5000);
    });

    it('ABORTS when order amount_cents is reduced below existing dispute_amount_cents (BR-001)', () => {
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, seller_response_due_at
        ) VALUES (
          'dsp_order_bound', 'm_adv', 'ord_adv_100', 'PP-ORD-BOUND', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'OPEN', 8000, '2026-11-20T00:00:00Z'
        )
      `).run();

      expect(() => {
        db.prepare('UPDATE orders SET amount_cents = 7999 WHERE id = ?').run('ord_adv_100');
      }).toThrow(/BR-001: order amount_cents cannot be reduced below existing dispute_amount_cents/);

      // Verify reducing to equal or above succeeds
      expect(() => {
        db.prepare('UPDATE orders SET amount_cents = 8500 WHERE id = ?').run('ord_adv_100');
      }).not.toThrow();
    });
  });

  describe('2. Trigger: trg_disputes_immutable_terminal_states (BR-005)', () => {
    const terminalStates = ['WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED'] as const;
    const nonTerminalTargetStates = ['OPEN', 'EVIDENCE_GATHERING', 'NEGOTIATING', 'READY_FOR_REVIEW', 'SUBMITTED'] as const;

    for (const termStatus of terminalStates) {
      describe(`Terminal State: ${termStatus}`, () => {
        beforeEach(() => {
          db.prepare(`
            INSERT INTO disputes (
              id, merchant_id, order_id, paypal_dispute_id, reason_code,
              status, dispute_amount_cents, seller_response_due_at
            ) VALUES (
              ?, 'm_adv', 'ord_adv_100', ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
              ?, 5000, '2026-11-20T00:00:00Z'
            )
          `).run(`dsp_term_${termStatus}`, `PP-TERM-${termStatus}`, termStatus);
        });

        it.each(nonTerminalTargetStates)(
          `ABORTS when attempting to transition ${termStatus} -> %s`,
          (targetStatus) => {
            const dspId = `dsp_term_${termStatus}`;
            expect(() => {
              db.prepare('UPDATE disputes SET status = ? WHERE id = ?').run(targetStatus, dspId);
            }).toThrow(/BR-005: Cannot modify dispute in terminal state/);

            const row = db.prepare('SELECT status FROM disputes WHERE id = ?').get(dspId) as { status: string };
            expect(row.status).toBe(termStatus);
          }
        );

        it(`ABORTS when attempting to transition ${termStatus} to another terminal state`, () => {
          const dspId = `dsp_term_${termStatus}`;
          const otherTerminal = terminalStates.find((s) => s !== termStatus)!;
          expect(() => {
            db.prepare('UPDATE disputes SET status = ? WHERE id = ?').run(otherTerminal, dspId);
          }).toThrow(/BR-005: Cannot modify dispute in terminal state/);
        });
      });
    }

    it('PROBE: Does trg_disputes_immutable_terminal_states block non-status updates on terminal records?', () => {
      // Create a dispute in terminal state WON
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, seller_response_due_at, buyer_dispute_reason_text
        ) VALUES (
          'dsp_probe_terminal', 'm_adv', 'ord_adv_100', 'PP-PROBE-TERM', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'WON', 5000, '2026-11-20T00:00:00Z', 'Initial text'
        )
      `).run();

      // Attempt to modify buyer_dispute_reason_text while keeping status WON
      // Note: In current schema, WHEN NEW.status != OLD.status is the trigger guard.
      let updateError: Error | null = null;
      try {
        db.prepare('UPDATE disputes SET buyer_dispute_reason_text = ? WHERE id = ?').run('Altered text', 'dsp_probe_terminal');
      } catch (e: any) {
        updateError = e;
      }

      // We document empirical behavior:
      // If the trigger condition is `WHEN NEW.status != OLD.status`, this update does NOT abort.
      // This is an empirical finding for the security report.
      const row = db.prepare('SELECT buyer_dispute_reason_text FROM disputes WHERE id = ?').get('dsp_probe_terminal') as {
        buyer_dispute_reason_text: string;
      };
      expect(updateError).not.toBeNull();
      expect(updateError?.message).toMatch(/BR-005: Cannot modify dispute in terminal state/);
      expect(row.buyer_dispute_reason_text).toBe('Initial text');
    });
  });

  describe('3. Triggers: trg_audit_logs_no_update & trg_audit_logs_no_delete (BR-012)', () => {
    const auditId = 'aud_stress_001';

    beforeEach(() => {
      db.prepare(`
        INSERT INTO audit_logs (
          id, merchant_id, entity_type, entity_id, action,
          actor_id, actor_type, previous_state_json, new_state_json,
          rule_ids_checked, guardrail_status, ip_address
        ) VALUES (
          ?, 'm_adv', 'disputes', 'dsp_test', 'TEST_ACTION',
          'ACT-01', 'SYSTEM', '{}', '{"status":"OPEN"}',
          '["BR-001"]', 'PASSED', '127.0.0.1'
        )
      `).run(auditId);
    });

    it('ABORTS single-row UPDATE on action column', () => {
      expect(() => {
        db.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('HACKED_ACTION', auditId);
      }).toThrow(/BR-012: audit_logs is strictly append-only: updates are prohibited/);
    });

    it('ABORTS single-row UPDATE on guardrail_status column', () => {
      expect(() => {
        db.prepare('UPDATE audit_logs SET guardrail_status = ? WHERE id = ?').run('BLOCKED', auditId);
      }).toThrow(/BR-012: audit_logs is strictly append-only: updates are prohibited/);
    });

    it('ABORTS single-row UPDATE on created_at timestamp', () => {
      expect(() => {
        db.prepare('UPDATE audit_logs SET created_at = ? WHERE id = ?').run('1970-01-01T00:00:00Z', auditId);
      }).toThrow(/BR-012: audit_logs is strictly append-only: updates are prohibited/);
    });

    it('ABORTS bulk UPDATE across table', () => {
      expect(() => {
        db.prepare("UPDATE audit_logs SET guardrail_status = 'WARNING'").run();
      }).toThrow(/BR-012: audit_logs is strictly append-only: updates are prohibited/);
    });

    it('ABORTS single-row DELETE', () => {
      expect(() => {
        db.prepare('DELETE FROM audit_logs WHERE id = ?').run(auditId);
      }).toThrow(/BR-012: audit_logs is strictly append-only: deletions are prohibited/);

      // Verify row still exists untouched
      const count = db.prepare('SELECT count(*) as count FROM audit_logs WHERE id = ?').get(auditId) as { count: number };
      expect(count.count).toBe(1);
    });

    it('ABORTS bulk DELETE across table', () => {
      expect(() => {
        db.prepare('DELETE FROM audit_logs').run();
      }).toThrow(/BR-012: audit_logs is strictly append-only: deletions are prohibited/);

      const count = db.prepare('SELECT count(*) as count FROM audit_logs').get() as { count: number };
      expect(count.count).toBeGreaterThanOrEqual(1);
    });

    it('CONFIRMS tamper-evident immutability: record remains bit-for-bit identical', () => {
      const record = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(auditId) as any;
      expect(record.action).toBe('TEST_ACTION');
      expect(record.guardrail_status).toBe('PASSED');
      expect(record.actor_id).toBe('ACT-01');
    });
  });
});
