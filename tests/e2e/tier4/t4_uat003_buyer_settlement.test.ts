/**
 * ChargebackShield — Tier 4 Real-World Application Workload: UAT-003
 * Buyer Pre-Escalation Partial Refund Settlement Scenario
 * Grounded in PRD §11 (UAT-003)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant, calculateCSuiteKPIs } from '../helpers/db-helper';
import { seedGoldenPersonas, GOLDEN_PERSONAS } from '../helpers/fixtures';
import { validateSettlementOffer } from '../tier1/t1_firewall_sandbox.test';
import { MockPayPalSimulator } from '../helpers/mock-paypal';

describe('Tier 4: UAT-003 Buyer Pre-Escalation Partial Refund Settlement', () => {
  let db: SqliteDbAdapter;
  let paypal: MockPayPalSimulator;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    seedGoldenPersonas(db);
    paypal = new MockPayPalSimulator();
  });

  afterEach(() => {
    db.close();
  });

  it('UAT-003: Open Negotiation for DSP-GOLD-003 ($120.00, SNAD, 40% cap $48.00) -> Buyer accepts $42.00 -> SETTLED_VIA_REFUND -> KPI-002 +$78.00', async () => {
    const persona = GOLDEN_PERSONAS['DSP-GOLD-003'];
    expect(persona).toBeDefined();

    // Baseline KPIs before settlement
    const beforeKPIs = calculateCSuiteKPIs(db);

    // 1. Verify Cap Check: $42.00 <= $48.00 (BR-004)
    const check = validateSettlementOffer(persona.amount_cents, 4200, 0.40);
    expect(check.allowed).toBe(true);
    expect(check.final_amount_cents).toBe(4200);

    // 2. Insert settlement offer
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('OFF-UAT-003', ?, 'NEG-GOLD-003', 4200, 4800, 'ACCEPTED', 'AGENT')
    `).run(persona.dispute_id);

    // 3. Call PayPal Sandbox API make-offer
    const ppOffer = await paypal.makeOffer(persona.paypal_dispute_id, {
      amount_cents: 4200,
      note: 'UAT-003 partial refund settlement'
    });
    expect(ppOffer.success).toBe(true);

    // 4. Update dispute status to SETTLED_VIA_REFUND
    db.prepare(`
      UPDATE disputes
      SET status = 'SETTLED_VIA_REFUND', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), version = version + 1
      WHERE id = ?
    `).run(persona.dispute_id);

    // 5. Update session status
    db.prepare(`UPDATE negotiation_sessions SET status = 'COMPLETED_SETTLED' WHERE dispute_id = ?`).run(persona.dispute_id);

    // 6. Verify KPI-002 and KPI-004 deltas
    const afterKPIs = calculateCSuiteKPIs(db);
    const revenueDelta = afterKPIs.kpi_002_net_revenue_saved_dollars - beforeKPIs.kpi_002_net_revenue_saved_dollars;
    const feeDelta = afterKPIs.kpi_004_fee_avoidance_dollars - beforeKPIs.kpi_004_fee_avoidance_dollars;

    // Revenue saved = $120.00 - $42.00 = $78.00
    expect(revenueDelta).toBe(78.0);
    // Fee saved = $15.00
    expect(feeDelta).toBe(15.0);
  });
});
