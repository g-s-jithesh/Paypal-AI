import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

// Legal state transition validator
const LEGAL_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['EVIDENCE_GATHERING', 'EXPIRED'],
  EVIDENCE_GATHERING: ['SUBMITTED', 'NEGOTIATING', 'SETTLED_VIA_REFUND', 'READY_FOR_REVIEW'],
  NEGOTIATING: ['SETTLED_VIA_REFUND', 'SUBMITTED', 'EXPIRED'],
  READY_FOR_REVIEW: ['SUBMITTED', 'SETTLED_VIA_REFUND', 'EXPIRED'],
  SUBMITTED: ['WON', 'LOST'],
  WON: [],
  LOST: [],
  SETTLED_VIA_REFUND: [],
  EXPIRED: [],
};

export function canTransition(fromStatus: string, toStatus: string): boolean {
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  return allowed ? allowed.includes(toStatus) : false;
}

export function executeTransition(
  db: Database,
  disputeId: string,
  fromStatus: string,
  toStatus: string,
  actorId: string = 'ACT-04',
  actorType: 'SYSTEM' | 'AI_AGENT' | 'MERCHANT_USER' | 'BUYER' = 'AI_AGENT'
): void {
  if (!canTransition(fromStatus, toStatus)) {
    throw new Error(`IllegalStateTransitionError: Cannot transition dispute from ${fromStatus} to ${toStatus}`);
  }

  db.transaction(() => {
    const dispute = db.prepare('SELECT version FROM disputes WHERE id = ?').get(disputeId) as { version: number };
    if (!dispute) throw new Error('Dispute not found');

    const updateRes = db
      .prepare(`
        UPDATE disputes
        SET status = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND status = ? AND version = ?
      `)
      .run(toStatus, disputeId, fromStatus, dispute.version);

    if (updateRes.changes === 0) {
      throw new Error('ConcurrencyConflictError: Dispute version mismatch');
    }

    db.prepare(`
      INSERT INTO audit_logs (
        id, merchant_id, entity_type, entity_id, action,
        actor_id, actor_type, previous_state_json, new_state_json,
        rule_ids_checked, guardrail_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `aud_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      'm1',
      'disputes',
      disputeId,
      `STATE_TRANSITION_${toStatus}`,
      actorId,
      actorType,
      JSON.stringify({ status: fromStatus }),
      JSON.stringify({ status: toStatus }),
      JSON.stringify(['BR-005', 'BR-012']),
      'PASSED'
    );
  })();
}

describe('Business Rules: Dispute State Machine (BR-005)', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m1', 'Test Merchant', 1500)
    `).run();
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@example.com', 'Buyer', 10000, 'Test Item')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  describe('13 Legal State Transitions', () => {
    const transitions = [
      { from: 'OPEN', to: 'EVIDENCE_GATHERING', desc: '1. OPEN -> EVIDENCE_GATHERING' },
      { from: 'EVIDENCE_GATHERING', to: 'SUBMITTED', desc: '2. EVIDENCE_GATHERING -> SUBMITTED (Track A)' },
      { from: 'EVIDENCE_GATHERING', to: 'NEGOTIATING', desc: '3. EVIDENCE_GATHERING -> NEGOTIATING (Track B)' },
      { from: 'EVIDENCE_GATHERING', to: 'SETTLED_VIA_REFUND', desc: '4. EVIDENCE_GATHERING -> SETTLED_VIA_REFUND (Track C)' },
      { from: 'EVIDENCE_GATHERING', to: 'READY_FOR_REVIEW', desc: '5. EVIDENCE_GATHERING -> READY_FOR_REVIEW (Track D)' },
      { from: 'NEGOTIATING', to: 'SETTLED_VIA_REFUND', desc: '6. NEGOTIATING -> SETTLED_VIA_REFUND (Offer Accepted)' },
      { from: 'NEGOTIATING', to: 'SUBMITTED', desc: '7. NEGOTIATING -> SUBMITTED (Offer Rejected / Fallback)' },
      { from: 'READY_FOR_REVIEW', to: 'SUBMITTED', desc: '8. READY_FOR_REVIEW -> SUBMITTED (Analyst Approved)' },
      { from: 'READY_FOR_REVIEW', to: 'SETTLED_VIA_REFUND', desc: '9. READY_FOR_REVIEW -> SETTLED_VIA_REFUND (Analyst Refund)' },
      { from: 'SUBMITTED', to: 'WON', desc: '10. SUBMITTED -> WON (PayPal favorable resolution)' },
      { from: 'SUBMITTED', to: 'LOST', desc: '11. SUBMITTED -> LOST (PayPal adverse resolution)' },
      { from: 'OPEN', to: 'EXPIRED', desc: '12. OPEN -> EXPIRED (Deadline passed)' },
      { from: 'READY_FOR_REVIEW', to: 'EXPIRED', desc: '13. READY_FOR_REVIEW -> EXPIRED (Deadline passed)' },
    ];

    it.each(transitions)('executes $desc cleanly with audit trail and version increment', ({ from, to }) => {
      const dspId = `dsp_${from}_${to}`;
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at, version)
        VALUES (?, 'm1', 'o1', ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', ?, 5000, '2026-11-20T00:00:00Z', 1)
      `).run(dspId, `PP-${dspId}`, from);

      expect(() => executeTransition(db, dspId, from, to)).not.toThrow();

      const updated = db.prepare('SELECT status, version FROM disputes WHERE id = ?').get(dspId) as {
        status: string;
        version: number;
      };
      expect(updated.status).toBe(to);
      expect(updated.version).toBe(2);

      const audit = db.prepare('SELECT count(*) as count FROM audit_logs WHERE entity_id = ?').get(dspId) as {
        count: number;
      };
      expect(audit.count).toBe(1);
    });
  });

  describe('10 Illegal State Transitions (Must be rejected)', () => {
    const illegalTransitions = [
      { from: 'WON', to: 'NEGOTIATING', desc: '1. WON -> NEGOTIATING' },
      { from: 'WON', to: 'OPEN', desc: '2. WON -> OPEN' },
      { from: 'LOST', to: 'SUBMITTED', desc: '3. LOST -> SUBMITTED' },
      { from: 'LOST', to: 'WON', desc: '4. LOST -> WON' },
      { from: 'EXPIRED', to: 'SUBMITTED', desc: '5. EXPIRED -> SUBMITTED' },
      { from: 'SETTLED_VIA_REFUND', to: 'SUBMITTED', desc: '6. SETTLED_VIA_REFUND -> SUBMITTED' },
      { from: 'SETTLED_VIA_REFUND', to: 'NEGOTIATING', desc: '7. SETTLED_VIA_REFUND -> NEGOTIATING' },
      { from: 'OPEN', to: 'WON', desc: '8. OPEN -> WON (Bypassing SUBMITTED)' },
      { from: 'OPEN', to: 'LOST', desc: '9. OPEN -> LOST' },
      { from: 'SUBMITTED', to: 'NEGOTIATING', desc: '10. SUBMITTED -> NEGOTIATING' },
    ];

    it.each(illegalTransitions)('rejects illegal transition: $desc', ({ from, to }) => {
      const dspId = `dsp_illegal_${from}_${to}`;
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at, version)
        VALUES (?, 'm1', 'o1', ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', ?, 5000, '2026-11-20T00:00:00Z', 1)
      `).run(dspId, `PP-${dspId}`, from);

      expect(() => executeTransition(db, dspId, from, to)).toThrow(/IllegalStateTransitionError/);

      // Verify status did not change
      const dsp = db.prepare('SELECT status, version FROM disputes WHERE id = ?').get(dspId) as {
        status: string;
        version: number;
      };
      expect(dsp.status).toBe(from);
      expect(dsp.version).toBe(1);
    });
  });

  it('BR-005 Database Trigger: Direct SQL UPDATE on terminal dispute is aborted', () => {
    const dspId = 'dsp_terminal_trigger';
    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES (?, 'm1', 'o1', 'PP-TERMINAL', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'WON', 5000, '2026-11-20T00:00:00Z')
    `).run(dspId);

    // Direct UPDATE of status on WON dispute must trigger SQLite ABORT
    expect(() => {
      db.prepare('UPDATE disputes SET status = ? WHERE id = ?').run('OPEN', dspId);
    }).toThrow(/BR-005: Cannot modify dispute in terminal state/);
  });
});
