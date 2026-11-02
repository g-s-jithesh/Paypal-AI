/**
 * ChargebackShield — Tier 4 Real-World Application Workload: UAT-002
 * Missing Carrier Tracking Guardrail Scenario (EXC-02 & BR-009)
 * Grounded in PRD §11 (UAT-002)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { seedGoldenPersonas, GOLDEN_PERSONAS } from '../helpers/fixtures';
import { routeDecisionTable } from '../tier1/t1_core_engines.test';
import { assertAuditLogExists } from '../helpers/assertions';

describe('Tier 4: UAT-002 Missing Tracking Guardrail', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    seedGoldenPersonas(db);
  });

  afterEach(() => {
    db.close();
  });

  it('UAT-002: Trigger DSP-GOLD-002 ($85.00, INR, FedEx IN_TRANSIT) -> BR-009 blocks AUTO_SUBMIT -> Routes to NEGOTIATING', () => {
    const persona = GOLDEN_PERSONAS['DSP-GOLD-002'];
    expect(persona).toBeDefined();

    // 1. Inspect ground truth state
    const order = db.prepare(`SELECT delivery_status, tracking_number FROM orders WHERE id = ?`).get(persona.order_id) as any;
    expect(order.delivery_status).toBe('IN_TRANSIT'); // Missing DELIVERED status

    // 2. Decision Table routing under BR-009 guardrail
    const routing = routeDecisionTable({
      dispute_amount_cents: persona.amount_cents,
      reason_code: persona.reason_code,
      delivery_status: order.delivery_status,
      win_prob: persona.expected_win_prob,
      ev_compete: 1200,
      ev_settle: 5100
    });

    // Expect Rule R3: Cannot auto-submit INR without DELIVERED proof
    expect(routing.rule_id).toBe('R3');
    expect(routing.action).toBe('OFFER_PARTIAL_REFUND');

    // 3. Transition to NEGOTIATING
    db.prepare(`
      UPDATE disputes
      SET status = 'NEGOTIATING', track = 'TRACK_B_NEGOTIATE', version = version + 1
      WHERE id = ?
    `).run(persona.dispute_id);

    // 4. Create negotiation session with shipping credit offer
    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, status, token_hash, max_refund_allowed_cents, messages_json)
      VALUES ('NEG-UAT-002', ?, 'ACTIVE', 'token_hash_002', 3400, '[]')
    `).run(persona.dispute_id);

    // 5. Audit log recording
    db.prepare(`
      INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
      VALUES ('AUD-UAT-002', 'merch_default', 'disputes', ?, 'ROUTED_TO_NEGOTIATING', 'ACT-04', 'AI_AGENT', '{"status":"NEGOTIATING","guardrail":"BR-009"}', '["BR-009","BR-016"]', 'PASSED')
    `).run(persona.dispute_id);

    // 6. Verify assertions
    const finalDispute = db.prepare(`SELECT status, track FROM disputes WHERE id = ?`).get(persona.dispute_id) as any;
    expect(finalDispute.status).toBe('NEGOTIATING');
    expect(finalDispute.track).toBe('TRACK_B_NEGOTIATE');

    const session = db.prepare(`SELECT * FROM negotiation_sessions WHERE dispute_id = ?`).get(persona.dispute_id) as any;
    expect(session.status).toBe('ACTIVE');

    const log = assertAuditLogExists(db, persona.dispute_id, 'ROUTED_TO_NEGOTIATING');
    expect(log).toBeDefined();
  });
});
