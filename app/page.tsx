import Link from 'next/link';
import { getDb } from '@/lib/db';
import { calculateCSuiteKPIs, getAnomalies, getReasonBreakdown, loadReplayRows } from '@/lib/kpi';
import { normalizeRefundPercentage } from '@/lib/firewall/policy-firewall';
import WhatIfSimulator from '@/components/WhatIfSimulator';

// Every request re-reads SQLite, so the scorecards always match the database
export const dynamic = 'force-dynamic';

const usd = (dollars: number) =>
  dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received (INR)',
  SIGNIFICANTLY_NOT_AS_DESCRIBED: 'Not as described (SNAD)',
  UNAUTHORISED: 'Unauthorised',
  CANCELLED_RECURRING_BILLING: 'Cancelled recurring billing',
  OTHER: 'Other',
};

export default function DashboardPage() {
  const db = getDb();
  const kpis = calculateCSuiteKPIs(db);
  const reasons = getReasonBreakdown(db);
  const anomalies = getAnomalies(db);
  const replayRows = loadReplayRows(db);
  const policy = (db.prepare(`
    SELECT max_auto_dispute_cents, max_refund_offer_pct, min_win_prob_auto_submit
    FROM policy_rules WHERE is_active = 1 ORDER BY version DESC LIMIT 1
  `).get() as any) ?? { max_auto_dispute_cents: 25000, max_refund_offer_pct: 0.4, min_win_prob_auto_submit: 0.75 };

  const cards = [
    { id: 'KPI-001', label: 'Win rate', value: `${kpis.kpi_001_win_rate_pct.toFixed(1)}%`, hint: 'Won ÷ (won + lost)' },
    { id: 'KPI-002', label: 'Net revenue saved', value: usd(kpis.kpi_002_net_revenue_saved_dollars), hint: 'Wins + settlement savings' },
    { id: 'KPI-003', label: 'Deflection rate', value: `${kpis.kpi_003_deflection_rate_pct.toFixed(1)}%`, hint: 'Settled before escalation' },
    { id: 'KPI-004', label: 'Fee avoidance', value: usd(kpis.kpi_004_fee_avoidance_dollars), hint: '$15 per non-lost case' },
    { id: 'KPI-005', label: 'Autonomous rate', value: `${kpis.kpi_005_autonomous_resolution_rate_pct.toFixed(1)}%`, hint: 'Resolved with no analyst override' },
    {
      id: 'KPI-006',
      label: 'Time to evidence',
      value: kpis.kpi_006_mttes_seconds === null ? '—' : `${kpis.kpi_006_mttes_seconds.toFixed(1)}s`,
      hint: 'Mean creation → submission',
    },
  ];

  const alerts = [
    { label: 'Past SLA deadline', value: anomalies.sla_breached, tone: 'red' },
    { label: 'Due within 48h', value: anomalies.sla_due_48h, tone: 'amber' },
    { label: 'Awaiting human review', value: anomalies.awaiting_human_review, tone: 'amber' },
    { label: 'Firewall interceptions', value: anomalies.guardrail_blocks, tone: 'blue' },
    { label: 'Quarantined webhooks', value: anomalies.quarantined_webhooks, tone: 'red' },
  ] as const;

  return (
    <main className="mx-auto max-w-7xl px-4 pb-32 pt-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">ChargebackShield</h1>
          <p className="mt-1 text-slate-300">Executive dispute command center · {kpis.total_disputes} disputes · live from SQLite</p>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm font-medium">
          <Link href="/disputes" className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-500">Dispute workbench</Link>
          <Link href="/disputes/DSP-GOLD-004" className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-slate-300 hover:bg-slate-800">High-value approval ($450)</Link>
          <Link href="/negotiate/DSP-GOLD-002" className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-2 text-slate-300 hover:bg-slate-800">Buyer negotiation</Link>
        </nav>
      </header>

      <section aria-label="Key performance indicators" className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <div key={c.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{c.label}</div>
            <div className="mt-2 text-2xl font-bold tabular-nums text-white">{c.value}</div>
            <div className="mt-1 text-xs text-slate-400">{c.hint}</div>
            <div className="mt-2 font-mono text-[10px] text-slate-400">{c.id}</div>
          </div>
        ))}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm lg:col-span-2">
          <h2 className="text-lg font-semibold">Outcomes by reason code</h2>
          <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-300">
            <Legend className="bg-emerald-500" label="Won" />
            <Legend className="bg-sky-500" label="Settled" />
            <Legend className="bg-rose-500" label="Lost / expired" />
            <Legend className="bg-slate-600" label="In progress" />
          </div>
          <ul className="mt-4 space-y-4">
            {reasons.map((r) => {
              const pct = (n: number) => `${(n / r.total) * 100}%`;
              const other = r.total - r.won - r.settled - r.lost - r.open;
              return (
                <li key={r.reason_code}>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{REASON_LABELS[r.reason_code] ?? r.reason_code}</span>
                    <span className="tabular-nums text-slate-400">
                      {r.total} disputes · {usd(r.amount_cents / 100)}
                    </span>
                  </div>
                  <div className="mt-1 flex h-3 overflow-hidden rounded-full bg-slate-800" role="img"
                    aria-label={`${r.won} won, ${r.settled} settled, ${r.lost + other} lost or expired, ${r.open} in progress`}>
                    <div className="bg-emerald-500" style={{ width: pct(r.won) }} />
                    <div className="bg-sky-500" style={{ width: pct(r.settled) }} />
                    <div className="bg-rose-500" style={{ width: pct(r.lost + other) }} />
                    <div className="bg-slate-600" style={{ width: pct(r.open) }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm">
          <h2 className="text-lg font-semibold">Anomaly watch</h2>
          <ul className="mt-4 divide-y divide-slate-800">
            {alerts.map((a) => (
              <li key={a.label} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${a.value === 0 ? 'bg-slate-600' : TONE[a.tone]}`} />
                  {a.label}
                </span>
                <span className={`tabular-nums font-semibold ${a.value === 0 ? 'text-slate-400' : 'text-white'}`}>{a.value}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <WhatIfSimulator
        rows={replayRows}
        baseline={{
          maxAutoDisputeCents: policy.max_auto_dispute_cents,
          maxRefundPct: normalizeRefundPercentage(policy.max_refund_offer_pct),
          minWinProb: policy.min_win_prob_auto_submit,
        }}
      />
    </main>
  );
}

const TONE = { red: 'bg-rose-500', amber: 'bg-amber-500', blue: 'bg-paypal-lightBlue' } as const;

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
