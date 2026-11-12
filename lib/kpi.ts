/**
 * ChargebackShield — C-Suite KPIs (KPI-001..006) and What-If policy replay.
 * The dashboard and the E2E reconciliation tests both run these exact queries,
 * so every number on screen is the SQL result (zero drift). Money stays in cents
 * until the final division for display (BR-023).
 */

// Satisfied by better-sqlite3 and the E2E test adapter
export interface KpiDb {
  prepare(sql: string): { get(...params: any[]): any; all(...params: any[]): any[] };
}

export interface CSuiteKPIs {
  kpi_001_win_rate_pct: number;
  kpi_002_net_revenue_saved_dollars: number;
  kpi_003_deflection_rate_pct: number;
  kpi_004_fee_avoidance_dollars: number;
  kpi_005_autonomous_resolution_rate_pct: number;
  kpi_006_mttes_seconds: number | null;
  total_disputes: number;
}

export function calculateCSuiteKPIs(db: KpiDb): CSuiteKPIs {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_disputes,
      -- KPI-001: won / (won + lost)
      ROUND(SUM(status = 'WON') * 100.0 / NULLIF(SUM(status IN ('WON', 'LOST')), 0), 2) AS win_rate_pct,
      -- KPI-002: full amount kept on wins, amount minus accepted refunds on settlements
      ROUND(SUM(CASE
        WHEN status = 'WON' THEN dispute_amount_cents
        WHEN status = 'SETTLED_VIA_REFUND' THEN dispute_amount_cents - COALESCE(
          (SELECT SUM(offered_amount_cents) FROM settlement_offers s WHERE s.dispute_id = d.id AND s.status = 'ACCEPTED'),
          dispute_amount_cents)
        ELSE 0 END) / 100.0, 2) AS net_revenue_saved_dollars,
      -- KPI-003: settled before escalation
      ROUND(SUM(status = 'SETTLED_VIA_REFUND') * 100.0 / NULLIF(COUNT(*), 0), 2) AS deflection_rate_pct,
      -- KPI-004: $15.00 chargeback fee avoided on every non-lost resolution
      ROUND(SUM(status IN ('WON', 'SETTLED_VIA_REFUND')) * 15.00, 2) AS fee_avoidance_dollars,
      -- KPI-005: resolved with no analyst override
      ROUND(SUM(status IN ('WON', 'SETTLED_VIA_REFUND') AND id NOT IN (
        SELECT entity_id FROM audit_logs WHERE actor_id = 'ACT-01' AND action = 'MANUAL_OVERRIDE'
      )) * 100.0 / NULLIF(COUNT(*), 0), 2) AS autonomous_resolution_rate_pct
    FROM disputes d
  `).get() as any;

  // KPI-006: mean seconds from dispute creation to evidence submission
  const mttes = db.prepare(`
    SELECT ROUND(AVG(strftime('%s', submitted_at) - strftime('%s', created_at)), 1) AS mttes_seconds
    FROM disputes
    WHERE status IN ('SUBMITTED', 'WON', 'LOST') AND submitted_at IS NOT NULL
  `).get() as any;

  return {
    kpi_001_win_rate_pct: row?.win_rate_pct ?? 0,
    kpi_002_net_revenue_saved_dollars: row?.net_revenue_saved_dollars ?? 0,
    kpi_003_deflection_rate_pct: row?.deflection_rate_pct ?? 0,
    kpi_004_fee_avoidance_dollars: row?.fee_avoidance_dollars ?? 0,
    kpi_005_autonomous_resolution_rate_pct: row?.autonomous_resolution_rate_pct ?? 0,
    kpi_006_mttes_seconds: mttes?.mttes_seconds ?? null,
    total_disputes: row?.total_disputes ?? 0,
  };
}

export interface ReasonBreakdown {
  reason_code: string;
  total: number;
  won: number;
  lost: number;
  settled: number;
  open: number;
  amount_cents: number;
}

export function getReasonBreakdown(db: KpiDb): ReasonBreakdown[] {
  return db.prepare(`
    SELECT reason_code,
           COUNT(*) AS total,
           SUM(status = 'WON') AS won,
           SUM(status = 'LOST') AS lost,
           SUM(status = 'SETTLED_VIA_REFUND') AS settled,
           SUM(status NOT IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')) AS open,
           SUM(dispute_amount_cents) AS amount_cents
    FROM disputes
    GROUP BY reason_code
    ORDER BY total DESC
  `).all() as ReasonBreakdown[];
}

export interface Anomalies {
  sla_breached: number;       // open disputes past seller_response_due_at
  sla_due_48h: number;        // open disputes due within 48 hours
  awaiting_human_review: number;
  guardrail_blocks: number;   // firewall interceptions (audit_logs BLOCKED)
  quarantined_webhooks: number;
}

export function getAnomalies(db: KpiDb, now: string = new Date().toISOString()): Anomalies {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM disputes WHERE status NOT IN ('WON','LOST','SETTLED_VIA_REFUND','EXPIRED') AND seller_response_due_at < @now) AS sla_breached,
      (SELECT COUNT(*) FROM disputes WHERE status NOT IN ('WON','LOST','SETTLED_VIA_REFUND','EXPIRED')
         AND seller_response_due_at >= @now AND seller_response_due_at < strftime('%Y-%m-%dT%H:%M:%fZ', @now, '+48 hours')) AS sla_due_48h,
      (SELECT COUNT(*) FROM disputes WHERE status = 'READY_FOR_REVIEW') AS awaiting_human_review,
      (SELECT COUNT(*) FROM audit_logs WHERE guardrail_status = 'BLOCKED') AS guardrail_blocks,
      (SELECT COUNT(*) FROM webhook_events WHERE processing_status = 'FAILED') AS quarantined_webhooks
  `).get({ now }) as Anomalies;
}

// ============================================================================
// What-If policy replay (pure, so the simulator can run it in the browser)
// ============================================================================

export interface ReplayRow {
  dispute_amount_cents: number;
  status: string;
  win_probability: number | null;
}

export interface WhatIfParams {
  maxRefundPct: number;        // 0.10..0.60
  maxAutoDisputeCents: number; // $100..$1,000
  minWinProb?: number;         // 0.50..0.95
}

export interface WhatIfProjection {
  projectedRevenueSavedDollars: number;
  projectedEscalatedCount: number;
  projectedAutonomousCount: number;
  projectedAutoSubmitCount: number;
  projectedAnalystHours: number;
}

// ponytail: flat per-case analyst effort; replace with measured handling time once the workbench logs it
export const ANALYST_HOURS_PER_ESCALATION = 0.75;

export function projectPolicy(rows: ReplayRow[], p: WhatIfParams): WhatIfProjection {
  const minWinProb = p.minWinProb ?? 0.75;
  let savedCents = 0;
  let escalated = 0;
  let autoSubmit = 0;

  for (const d of rows) {
    if (d.dispute_amount_cents > p.maxAutoDisputeCents) {
      escalated++;
    } else if ((d.win_probability ?? 0) >= minWinProb) {
      autoSubmit++;
    }

    if (d.status === 'WON') {
      savedCents += d.dispute_amount_cents;
    } else if (d.status === 'SETTLED_VIA_REFUND') {
      savedCents += d.dispute_amount_cents - Math.floor(d.dispute_amount_cents * p.maxRefundPct);
    }
  }

  return {
    projectedRevenueSavedDollars: savedCents / 100,
    projectedEscalatedCount: escalated,
    projectedAutonomousCount: rows.length - escalated,
    projectedAutoSubmitCount: autoSubmit,
    projectedAnalystHours: escalated * ANALYST_HOURS_PER_ESCALATION,
  };
}

export function loadReplayRows(db: KpiDb): ReplayRow[] {
  return db.prepare(`
    SELECT d.dispute_amount_cents, d.status,
           (SELECT a.win_probability FROM ai_assessments a WHERE a.dispute_id = d.id ORDER BY a.created_at DESC LIMIT 1) AS win_probability
    FROM disputes d
  `).all() as ReplayRow[];
}

/** Read-only replay of every stored dispute under a hypothetical policy. */
export function simulateWhatIfPolicy(
  db: KpiDb,
  maxRefundPct: number,
  maxAutoDisputeCents: number,
  minWinProb?: number
): WhatIfProjection {
  return projectPolicy(loadReplayRows(db), { maxRefundPct, maxAutoDisputeCents, minWinProb });
}
