'use client';

import { useState } from 'react';
import { projectPolicy, type ReplayRow, type WhatIfParams } from '@/lib/kpi';

interface Props {
  rows: ReplayRow[];
  baseline: Required<WhatIfParams>;
}

const usd = (dollars: number) => dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Replays every stored dispute against hypothetical policy thresholds. Read-only: nothing is written. */
export default function WhatIfSimulator({ rows, baseline }: Props) {
  const [params, setParams] = useState(baseline);
  const before = projectPolicy(rows, baseline);
  const after = projectPolicy(rows, params);
  const set = (key: keyof WhatIfParams) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setParams({ ...params, [key]: Number(e.target.value) });

  const results = [
    { label: 'Net revenue saved', now: usd(after.projectedRevenueSavedDollars), delta: after.projectedRevenueSavedDollars - before.projectedRevenueSavedDollars, fmt: usd, goodUp: true },
    { label: 'Analyst hours', now: `${after.projectedAnalystHours.toFixed(2)} h`, delta: after.projectedAnalystHours - before.projectedAnalystHours, fmt: (n: number) => `${n.toFixed(2)} h`, goodUp: false },
    { label: 'Escalated to humans', now: String(after.projectedEscalatedCount), delta: after.projectedEscalatedCount - before.projectedEscalatedCount, fmt: String, goodUp: false },
    { label: 'Auto-submitted evidence', now: String(after.projectedAutoSubmitCount), delta: after.projectedAutoSubmitCount - before.projectedAutoSubmitCount, fmt: String, goodUp: true },
  ];

  return (
    <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-sm" aria-labelledby="whatif-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="whatif-title" className="text-lg font-semibold">What-If policy simulator</h2>
        <button onClick={() => setParams(baseline)} className="text-sm text-paypal-lightBlue hover:underline">
          Reset to live policy
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-400">
        Replays all {rows.length} disputes against new thresholds. Changes are projected only; the live policy is not modified.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <Slider
            label="Human review above (BR-006)"
            value={`$${(params.maxAutoDisputeCents / 100).toFixed(0)}`}
            min={10000} max={100000} step={500}
            raw={params.maxAutoDisputeCents} onChange={set('maxAutoDisputeCents')}
          />
          <Slider
            label="Max refund offer (BR-004)"
            value={`${Math.round(params.maxRefundPct * 100)}%`}
            min={0.1} max={0.6} step={0.01}
            raw={params.maxRefundPct} onChange={set('maxRefundPct')}
          />
          <Slider
            label="Min win probability to auto-submit"
            value={`${Math.round(params.minWinProb * 100)}%`}
            min={0.5} max={0.95} step={0.01}
            raw={params.minWinProb} onChange={set('minWinProb')}
          />
        </div>

        <dl className="grid grid-cols-2 gap-4">
          {results.map((r) => {
            const tone = r.delta === 0 ? 'text-slate-400' : (r.delta > 0) === r.goodUp ? 'text-emerald-400' : 'text-rose-400';
            return (
              <div key={r.label} className="rounded-lg bg-slate-800/60 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{r.label}</dt>
                <dd className="mt-1 text-xl font-bold tabular-nums">{r.now}</dd>
                <dd className={`text-sm tabular-nums ${tone}`}>
                  {r.delta === 0 ? 'no change' : `${r.delta > 0 ? '+' : '−'}${r.fmt(Math.abs(r.delta))}`}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </section>
  );
}

function Slider(props: {
  label: string; value: string; min: number; max: number; step: number; raw: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-sm">
        <span className="font-medium text-slate-300">{props.label}</span>
        <span className="tabular-nums font-semibold text-sky-300">{props.value}</span>
      </span>
      <input
        type="range" className="mt-2 w-full accent-paypal-lightBlue"
        min={props.min} max={props.max} step={props.step} value={props.raw} onChange={props.onChange}
      />
    </label>
  );
}
