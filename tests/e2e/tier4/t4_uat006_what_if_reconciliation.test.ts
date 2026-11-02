/**
 * ChargebackShield — Tier 4 Real-World Application Workload: UAT-006
 * C-Suite What-If Policy ROI Simulator SQL Reconciliation
 * Grounded in PRD §11 (UAT-006)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { seedGoldenPersonas } from '../helpers/fixtures';
import { simulateWhatIfPolicy } from '../tier1/t1_csuite_kpi.test';

describe('Tier 4: UAT-006 C-Suite What-If Simulator SQL Reconciliation', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    seedGoldenPersonas(db);

    // Set DSP-GOLD-003 as SETTLED_VIA_REFUND for realistic historical replay
    db.prepare(`UPDATE disputes SET status = 'SETTLED_VIA_REFUND' WHERE id = 'DSP-GOLD-003'`).run();
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('OFF-UAT-6', 'DSP-GOLD-003', 'NEG-GOLD-003', 4800, 4800, 'ACCEPTED', 'AGENT')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('UAT-006: Adjust Policy Cap slider $250 -> $500 and Max Refund 40% -> 30% -> Verify simulated delta matches SQL calculation', () => {
    // 1. Initial baseline simulation (Cap = $250.00, Refund = 40%)
    const baseline = simulateWhatIfPolicy(db, 0.40, 25000);

    // 2. Tuned policy simulation (Cap = $500.00, Refund = 30%)
    const tuned = simulateWhatIfPolicy(db, 0.30, 50000);

    // 3. Verification of What-If delta outcomes:
    // With max refund decreased from 40% to 30%, merchant retains 70% of $120.00 ($84.00) instead of 60% ($72.00)
    // Projected Revenue Saved increases by $12.00
    const deltaRevenue = tuned.projectedRevenueSavedDollars - baseline.projectedRevenueSavedDollars;
    expect(deltaRevenue).toBe(12.0);

    // With auto-cap raised from $250 to $500, DSP-GOLD-004 ($450.00) becomes autonomous
    expect(tuned.projectedAutonomousCount).toBe(baseline.projectedAutonomousCount + 1);
    expect(tuned.projectedEscalatedCount).toBe(baseline.projectedEscalatedCount - 1);

    // 4. Invariant: Database state remains unmutated (read-only historical replay)
    const activePolicy = db.prepare(`SELECT max_auto_dispute_cents, max_refund_offer_pct FROM policy_rules WHERE merchant_id = 'merch_default'`).get() as any;
    expect(activePolicy.max_auto_dispute_cents).toBe(25000);
    expect(activePolicy.max_refund_offer_pct).toBe(0.40);
  });
});
