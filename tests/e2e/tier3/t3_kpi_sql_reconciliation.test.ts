/**
 * ChargebackShield — Tier 3 Cross-Feature Combination: Dynamic Mutations to Live SQL KPI Reconciliation
 * Validates zero-drift parity between dynamic dispute state changes and live SQL C-Suite metrics
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant, calculateCSuiteKPIs } from '../helpers/db-helper';
import { seedGoldenPersonas } from '../helpers/fixtures';

describe('Tier 3: Dynamic Mutations to Live SQL KPI Reconciliation', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    seedGoldenPersonas(db);
  });

  afterEach(() => {
    db.close();
  });

  it('T3-INT-4: Reconciles all 6 KPIs across 5 dynamic dispute lifecycle transitions', () => {
    // 1. DSP-GOLD-001 ($145.00) transitions to WON
    db.prepare(`UPDATE disputes SET status = 'WON', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = 'DSP-GOLD-001'`).run();

    // 2. DSP-GOLD-002 ($85.00) transitions to LOST
    db.prepare(`UPDATE disputes SET status = 'LOST', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = 'DSP-GOLD-002'`).run();

    // 3. DSP-GOLD-003 ($120.00) transitions to SETTLED_VIA_REFUND with $42.00 accepted offer (saving $78.00)
    db.prepare(`UPDATE disputes SET status = 'SETTLED_VIA_REFUND', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = 'DSP-GOLD-003'`).run();
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('OFF-INT-3', 'DSP-GOLD-003', 'NEG-GOLD-003', 4200, 4800, 'ACCEPTED', 'AGENT')
    `).run();

    // 4. DSP-GOLD-005 ($28.00) transitions to SETTLED_VIA_REFUND via Auto-Accept (full refund $28.00)
    db.prepare(`UPDATE disputes SET status = 'SETTLED_VIA_REFUND', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = 'DSP-GOLD-005'`).run();
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('OFF-INT-5', 'DSP-GOLD-005', 'NEG-GOLD-003', 2800, 2800, 'ACCEPTED', 'AGENT')
    `).run();

    // 5. DSP-GOLD-004 ($450.00) remains in READY_FOR_REVIEW

    // Run Live SQL KPI Engine
    const kpis = calculateCSuiteKPIs(db);

    // KPI-001: Win Rate % = WON / (WON + LOST) = 1 / (1 + 1) = 50.00%
    expect(kpis.kpi_001_win_rate_pct).toBe(50.0);

    // KPI-002: Net Revenue Saved ($)
    // WON DSP-GOLD-001 = $145.00
    // SETTLED DSP-GOLD-003 = ($120.00 - $42.00) = $78.00
    // SETTLED DSP-GOLD-005 = ($28.00 - $28.00) = $0.00
    // Total = $145.00 + $78.00 = $223.00
    expect(kpis.kpi_002_net_revenue_saved_dollars).toBe(223.0);

    // KPI-003: Deflection Rate % = SETTLED / Total = 2 / 5 = 40.00%
    expect(kpis.kpi_003_deflection_rate_pct).toBe(40.0);

    // KPI-004: Chargeback Fee Avoidance = (WON + SETTLED) * $15.00 = (1 + 2) * $15.00 = 3 * $15.00 = $45.00
    expect(kpis.kpi_004_fee_avoidance_dollars).toBe(45.0);

    // KPI-005: Autonomous Resolution Rate % = (WON + SETTLED without manual override) / Total = 3 / 5 = 60.00%
    expect(kpis.kpi_005_autonomous_resolution_rate_pct).toBe(60.0);

    // Total count matches exact records
    expect(kpis.total_disputes).toBe(5);
  });
});
