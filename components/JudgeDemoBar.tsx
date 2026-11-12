'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ScrollText, ShieldAlert, RotateCcw, Webhook, X } from 'lucide-react';

interface AuditEntry {
  id: string;
  entity_id: string;
  action: string;
  actor_type: string;
  rule_ids_checked: string;
  guardrail_status: 'PASSED' | 'BLOCKED' | 'WARNING';
  new_state_json: string;
  created_at: string;
}

const STATUS_STYLE = {
  PASSED: 'bg-emerald-500/15 text-emerald-300',
  BLOCKED: 'bg-rose-500/15 text-rose-300',
  WARNING: 'bg-amber-500/15 text-amber-300',
} as const;

/** Fixed bottom bar with one-click demo actions for judges. */
export default function JudgeDemoBar() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'warn' | 'error' } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);

  async function run(name: string, url: string, describe: (data: any) => { text: string; tone: 'ok' | 'warn' }) {
    setBusy(name);
    setMessage(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      setMessage(res.ok ? describe(data) : { text: data.error ?? `Request failed (${res.status})`, tone: 'error' });
      router.refresh();
      if (audit) await loadAudit();
    } catch (err: any) {
      setMessage({ text: err.message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function loadAudit() {
    const res = await fetch('/api/demo', { cache: 'no-store' });
    setAudit((await res.json()).entries ?? []);
  }

  const cents = (c: number) => `$${(c / 100).toFixed(2)}`;
  const actions = [
    {
      name: 'webhook', label: 'Trigger webhook', icon: Webhook,
      onClick: () => run('webhook', '/api/simulator/webhook', (d) => ({
        text: `CUSTOMER.DISPUTE.CREATED → ${d.result.dispute_id}: win ${Math.round(d.result.win_probability * 100)}%, `
          + `rule ${d.result.rule_id} → ${d.result.action} (${d.result.status})`,
        tone: 'ok',
      })),
    },
    {
      name: 'injection', label: 'Injection test', icon: ShieldAlert,
      onClick: () => run('injection', '/api/demo', (d) => ({
        text: `Buyer jailbreak on ${d.dispute_id}: Layer 1 ${d.layer1_detected ? `flagged ${d.layer1_patterns.join(', ')}` : 'missed it'}; `
          + `${cents(d.requested_cents)} refund clamped to ${cents(d.executed_cents)}${d.interception ? ` (${d.interception.uiAlert.badge})` : ''}`,
        tone: 'warn',
      })),
    },
    {
      name: 'audit', label: 'Audit trail', icon: ScrollText,
      onClick: async () => { setBusy('audit'); await loadAudit(); setBusy(null); },
    },
    {
      name: 'reset', label: 'Reset dataset', icon: RotateCcw,
      onClick: () => run('reset', '/api/simulator/reset', (d) => ({
        text: `Golden Dataset restored: ${d.dispute_count} disputes in ${d.duration_ms} ms`,
        tone: 'ok',
      })),
    },
  ];

  return (
    <>
      {audit && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-800 bg-slate-900 shadow-2xl" aria-label="MCP audit trail">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="font-semibold">MCP audit trail <span className="text-sm font-normal text-slate-400">(latest {audit.length})</span></h2>
            <button onClick={() => setAudit(null)} aria-label="Close audit trail" className="rounded p-1 hover:bg-slate-800"><X size={18} /></button>
          </div>
          <ol className="flex-1 divide-y divide-slate-800 overflow-y-auto pb-24">
            {audit.length === 0 && <li className="p-4 text-sm text-slate-400">No audit entries yet.</li>}
            {audit.map((e) => (
              <li key={e.id} className="p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold">{e.action}</span>
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[e.guardrail_status]}`}>{e.guardrail_status}</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {e.entity_id} · {e.actor_type} · {safeRules(e.rule_ids_checked)} · {new Date(e.created_at).toLocaleTimeString()}
                </div>
                <pre className="mt-2 overflow-x-auto rounded bg-slate-800/60 p-2 text-[11px] text-slate-300">{pretty(e.new_state_json)}</pre>
              </li>
            ))}
          </ol>
        </aside>
      )}

      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-paypal-darkBlue bg-paypal-darkBlue text-white shadow-lg">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3 sm:px-8">
          <span className="mr-2 text-xs font-semibold uppercase tracking-wider text-paypal-accent">Judge demo</span>
          {actions.map(({ name, label, icon: Icon, onClick }) => (
            <button
              key={name} onClick={onClick} disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
            >
              <Icon size={15} aria-hidden /> {busy === name ? 'Working…' : label}
            </button>
          ))}
          {message && (
            <p role="status" className={`w-full text-sm sm:ml-2 sm:w-auto sm:flex-1 ${message.tone === 'error' ? 'text-rose-300' : message.tone === 'warn' ? 'text-amber-200' : 'text-emerald-200'}`}>
              {message.text}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function safeRules(json: string) {
  try { return (JSON.parse(json) as string[]).join(', '); } catch { return json; }
}

function pretty(json: string) {
  try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json; }
}
