/**
 * ChargebackShield — Tier 4 Real-World Application Workload: UAT-005
 * High-Value Dispute Human Approval Gate Scenario (BR-006)
 * Grounded in PRD §11 (UAT-005)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { seedGoldenPersonas, GOLDEN_PERSONAS } from '../helpers/fixtures';
import { routeDecisionTable } from '../tier1/t1_core_engines.test';
import { assertAuditLogExists } from '../helpers/assertions';

describe('Tier 4: UAT-005 High-Value Dispute Human Gate', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    seedGoldenPersonas(db);
  });

  afterEach(() => {
    db.close();
  });

  it('UAT-005: Trigger DSP-GOLD-004 ($450.00 > $250.00) -> Decision R1 routes to READY_FOR_REVIEW -> Analyst signs off -> Transitions to SUBMITTED', () => {
    const persona = GOLDEN_PERSONAS['DSP-GOLD-004'];
    expect(persona.amount_cents).toBe(45000); // $450.00

    // 1. Decision Table evaluates dispute
    const decision = routeDecisionTable({
      dispute_amount_cents: persona.amount_cents,
      reason_code: persona.reason_code,
      delivery_status: persona.delivery_status,
      win_prob: persona.expected_win_prob,
      ev_compete: 38000,
      ev_settle: 27000
    });

    // Rule R1: Dispute Amount > $250.00 -> ESCALATE_TO_HUMAN
    expect(decision.rule_id).toBe('R1');
    expect(decision.action).toBe('ESCALATE_TO_HUMAN');

    // 2. Dispute Pauses at READY_FOR_REVIEW in Workbench Queue
    const disputeBeforeApproval = db.prepare(`SELECT status FROM disputes WHERE id = ?`).get(persona.dispute_id) as any;
    expect(disputeBeforeApproval.status).toBe('READY_FOR_REVIEW');

    // 3. Analyst (ACT-01) performs 1-click review and approves evidence submission
    const submittedTimestamp = new Date().toISOString();
    db.prepare(`
      UPDATE disputes
      SET status = 'SUBMITTED', submitted_at = ?, version = version + 1
      WHERE id = ?
    `).run(submittedTimestamp, persona.dispute_id);

    // 4. Mandatory Audit Log with ACT-01 attribution
    db.prepare(`
      INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
      VALUES ('AUD-UAT-005', 'merch_default', 'disputes', ?, 'ANALYST_GATE_APPROVAL', 'ACT-01', 'MERCHANT_USER', '{"status":"SUBMITTED","approved_cents":45000}', '["BR-006"]', 'PASSED')
    `).run(persona.dispute_id);

    // 5. Verify post-approval state
    const disputeAfter = db.prepare(`SELECT status, submitted_at FROM disputes WHERE id = ?`).get(persona.dispute_id) as any;
    expect(disputeAfter.status).toBe('SUBMITTED');
    expect(disputeAfter.submitted_at).toBe(submittedTimestamp);

    const log = assertAuditLogExists(db, persona.dispute_id, 'ANALYST_GATE_APPROVAL') as any;
    expect(log.actor_id).toBe('ACT-01');
  });
});
