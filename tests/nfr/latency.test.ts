import { describe, it, expect } from 'vitest';
import { getSeededDb } from '../helpers/db-helper';
import { routeStep18, calculateEvCompete } from '../helpers/rule-fixtures';

describe('Non-Functional Requirements: Latency Benchmarks (TC-NFR-007)', () => {
  it('TC-NFR-007: C-Suite KPI Queries execute in < 50ms (p95)', () => {
    const db = getSeededDb();
    const merchantId = 'merch_default';

    const kpiQueries = [
      {
        name: 'KPI-001 (Win Rate %)',
        sql: `
          SELECT ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / 
                NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct
          FROM disputes WHERE merchant_id = ?;
        `,
      },
      {
        name: 'KPI-002 (Net Revenue Saved)',
        sql: `
          SELECT ROUND(SUM(
            CASE 
              WHEN d.status = 'WON' THEN d.dispute_amount_cents 
              WHEN d.status = 'SETTLED_VIA_REFUND' THEN (d.dispute_amount_cents - COALESCE(so.offered_amount_cents, d.dispute_amount_cents))
              ELSE 0 
            END
          ) / 100.0, 2) AS net_revenue_saved
          FROM disputes d
          LEFT JOIN settlement_offers so ON d.id = so.dispute_id AND so.status = 'EXECUTED'
          WHERE d.merchant_id = ?;
        `,
      },
      {
        name: 'KPI-003 (Deflection Rate %)',
        sql: `
          SELECT ROUND(COUNT(CASE WHEN status = 'SETTLED_VIA_REFUND' THEN 1 END) * 100.0 / 
                NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED') THEN 1 END), 0), 2) AS deflection_rate_pct
          FROM disputes WHERE merchant_id = ?;
        `,
      },
      {
        name: 'KPI-004 (Fee Avoidance)',
        sql: `
          SELECT ROUND(SUM(CASE WHEN d.status IN ('WON', 'SETTLED_VIA_REFUND') THEN m.chargeback_fee_cents ELSE 0 END) / 100.0, 2) AS fee_avoidance
          FROM disputes d
          JOIN merchants m ON d.merchant_id = m.id
          WHERE d.merchant_id = ?;
        `,
      },
      {
        name: 'KPI-005 (Autonomous Rate %)',
        sql: `
          SELECT ROUND(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND') AND NOT EXISTS (
            SELECT 1 FROM audit_logs a WHERE a.entity_id = d.id AND a.actor_type = 'MERCHANT_USER'
          ) THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND','EXPIRED') THEN 1 END), 0), 2) AS autonomous_rate
          FROM disputes d WHERE d.merchant_id = ?;
        `,
      },
      {
        name: 'KPI-006 (MTTES Latency)',
        sql: `
          SELECT ROUND(AVG((julianday(submitted_at) - julianday(created_at)) * 86400.0), 1) AS mttes_seconds
          FROM disputes
          WHERE merchant_id = ? AND status IN ('SUBMITTED', 'WON', 'LOST') AND submitted_at IS NOT NULL;
        `,
      },
    ];

    for (const q of kpiQueries) {
      const stmt = db.prepare(q.sql);
      const timings: number[] = [];

      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        stmt.get(merchantId);
        const duration = performance.now() - start;
        timings.push(duration);
      }

      timings.sort((a, b) => a - b);
      const p95 = timings[Math.floor(timings.length * 0.95)];
      console.log(`  ⏱️ ${q.name} p95 execution time: ${p95.toFixed(2)}ms`);

      expect(p95).toBeLessThan(50.0);
    }
  });

  it('TC-NFR-002: Decision Engine Assessment Latency < 250ms', () => {
    const timings: number[] = [];

    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const winProb = 0.85;
      const amountCents = 14500;
      calculateEvCompete(winProb, amountCents);
      routeStep18({
        disputeAmountCents: amountCents,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        winProbability: winProb,
      });
      const duration = performance.now() - start;
      timings.push(duration);
    }

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95)];
    console.log(`  ⚡ Decision Engine p95 execution time: ${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(250.0);
  });
});
