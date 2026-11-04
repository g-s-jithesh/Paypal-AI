'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Shield,
  Search,
  Filter,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ArrowRight,
  Sparkles,
  FileCheck,
  MessageSquare,
  AlertCircle,
  TrendingUp,
} from 'lucide-react';

interface DisputeSummary {
  id: string;
  order_id: string;
  paypal_dispute_id: string;
  reason_code: string;
  status: string;
  dispute_amount_cents: number;
  currency: string;
  seller_response_due_at: string;
  stage: string;
  track: string | null;
  version: number;
  customer_name: string | null;
  customer_email: string | null;
  carrier_name: string | null;
  tracking_number: string | null;
  delivery_status: string | null;
  item_summary: string | null;
  order_amount_cents: number | null;
  win_probability: number | null;
  recommended_action: string | null;
  evidence_count: number;
  verified_evidence_count: number;
  hours_remaining: number;
  sla_urgency: 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'NORMAL';
  is_high_value: boolean;
}

const STATUS_TABS = [
  { id: 'ALL', label: 'All Disputes' },
  { id: 'OPEN', label: 'Open' },
  { id: 'EVIDENCE_GATHERING', label: 'Evidence Gathering' },
  { id: 'READY_FOR_REVIEW', label: 'Ready for Review' },
  { id: 'NEGOTIATING', label: 'Negotiating' },
  { id: 'SUBMITTED', label: 'Submitted' },
  { id: 'SETTLED_VIA_REFUND', label: 'Settled via Refund' },
  { id: 'WON', label: 'Won' },
  { id: 'LOST', label: 'Lost' },
  { id: 'EXPIRED', label: 'Expired' },
];

export default function DisputeWorkbenchPage() {
  const [disputes, setDisputes] = useState<DisputeSummary[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<string>('ALL');
  const [reasonFilter, setReasonFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchDisputes = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (activeTab !== 'ALL') params.set('status', activeTab);
      if (reasonFilter !== 'ALL') params.set('reason', reasonFilter);
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      params.set('limit', '100');

      const res = await fetch(`/api/disputes?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setDisputes(data.disputes || []);
        setStatusCounts(data.statusCounts || {});
        setLastRefreshed(new Date());
      }
    } catch (err) {
      console.error('Failed to load disputes:', err);
    } finally {
      setLoading(false);
    }
  }, [activeTab, reasonFilter, searchQuery]);

  useEffect(() => {
    fetchDisputes();
  }, [fetchDisputes]);

  // Derived high-level stats
  const highValueCount = disputes.filter((d) => d.is_high_value && ['READY_FOR_REVIEW', 'OPEN'].includes(d.status)).length;
  const criticalSlaCount = disputes.filter((d) => d.sla_urgency === 'CRITICAL').length;
  const inNegotiationCount = disputes.filter((d) => d.status === 'NEGOTIATING').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold text-lg text-white tracking-tight">ChargebackShield</span>
              <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                Analyst Workbench
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-sm font-medium text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"
            >
              <TrendingUp className="h-4 w-4" />
              C-Suite BI Dashboard
            </Link>
            <div className="h-4 w-px bg-slate-800" />
            <button
              onClick={fetchDisputes}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
              title="Refresh queue"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-blue-400' : ''}`} />
              Sync Queue
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full space-y-6">
        {/* KPI Alert Banners */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <FileCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-2xl font-bold text-white">{statusCounts['ALL'] || 0}</div>
              <div className="text-xs text-slate-400 font-medium">Total Disputes in Pipeline</div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-amber-500/20 bg-amber-500/5 flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-300">{highValueCount}</div>
              <div className="text-xs text-slate-400 font-medium">High-Value Gates (&gt; $250, BR-006)</div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-red-500/20 bg-red-500/5 flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-red-500/10 text-red-400 border border-red-500/30">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <div className="text-2xl font-bold text-red-300">{criticalSlaCount}</div>
              <div className="text-xs text-slate-400 font-medium">Critical SLA (&le; 4h, BR-010)</div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-purple-500/20 bg-purple-500/5 flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/30">
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <div className="text-2xl font-bold text-purple-300">{inNegotiationCount}</div>
              <div className="text-xs text-slate-400 font-medium">Active Buyer Negotiations</div>
            </div>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4 space-y-4">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search by Dispute ID, PayPal ID, Order ID, Customer name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-950/80 border border-slate-800 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              />
            </div>

            {/* Reason Code Dropdown */}
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-slate-400" />
              <select
                value={reasonFilter}
                onChange={(e) => setReasonFilter(e.target.value)}
                className="bg-slate-950/80 border border-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
              >
                <option value="ALL">All Dispute Reasons</option>
                <option value="MERCHANDISE_OR_SERVICE_NOT_RECEIVED">Item Not Received (INR)</option>
                <option value="SIGNIFICANTLY_NOT_AS_DESCRIBED">Significantly Not as Described (SNAD)</option>
                <option value="UNAUTHORISED">Unauthorised Transaction</option>
                <option value="CANCELLED_RECURRING_BILLING">Cancelled Billing</option>
              </select>
            </div>
          </div>

          {/* Status Tabs with Live Count Badges */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
            {STATUS_TABS.map((tab) => {
              const count = statusCounts[tab.id] ?? 0;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex items-center gap-2 ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-950/60 text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 border border-slate-800/60'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                      isActive ? 'bg-blue-700 text-blue-100' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Dispute Table */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 border-b border-slate-800 text-xs font-semibold uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3.5 px-4">Dispute &amp; Order</th>
                  <th className="py-3.5 px-4">Customer</th>
                  <th className="py-3.5 px-4">Reason &amp; Amount</th>
                  <th className="py-3.5 px-4">Status &amp; Track</th>
                  <th className="py-3.5 px-4">SLA Deadline</th>
                  <th className="py-3.5 px-4">AI Recommendation</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-normal">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-slate-400">
                      <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-blue-400" />
                      Loading dispute autopilot queue...
                    </td>
                  </tr>
                ) : disputes.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-slate-400">
                      <AlertCircle className="h-8 w-8 mx-auto mb-2 text-slate-500" />
                      No disputes match the selected filters.
                    </td>
                  </tr>
                ) : (
                  disputes.map((d) => {
                    const amountFormatted = `$${(d.dispute_amount_cents / 100).toFixed(2)}`;
                    const winPct = d.win_probability !== null ? `${Math.round(d.win_probability * 100)}%` : '—';

                    // Urgency Badge Styling
                    let slaBadgeClass = 'bg-slate-800 text-slate-300 border-slate-700';
                    let slaLabel = `${d.hours_remaining}h left`;
                    if (d.sla_urgency === 'EXPIRED') {
                      slaBadgeClass = 'bg-red-950/80 text-red-300 border-red-800/80';
                      slaLabel = 'EXPIRED';
                    } else if (d.sla_urgency === 'CRITICAL') {
                      slaBadgeClass = 'bg-red-500/20 text-red-300 border-red-500/40 animate-pulse';
                      slaLabel = `🚨 ${d.hours_remaining}h (BR-010)`;
                    } else if (d.sla_urgency === 'WARNING') {
                      slaBadgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
                      slaLabel = `⚠️ ${d.hours_remaining}h remaining`;
                    }

                    // Status Badge Styling
                    let statusBadgeClass = 'bg-slate-800 text-slate-300 border-slate-700';
                    if (d.status === 'OPEN') statusBadgeClass = 'bg-blue-500/15 text-blue-300 border-blue-500/30';
                    if (d.status === 'READY_FOR_REVIEW') statusBadgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/40 font-semibold';
                    if (d.status === 'NEGOTIATING') statusBadgeClass = 'bg-purple-500/20 text-purple-300 border-purple-500/40';
                    if (d.status === 'SUBMITTED') statusBadgeClass = 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40';
                    if (d.status === 'WON' || d.status === 'SETTLED_VIA_REFUND') statusBadgeClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-medium';
                    if (d.status === 'LOST') statusBadgeClass = 'bg-red-500/20 text-red-300 border-red-500/30';

                    return (
                      <tr key={d.id} className="hover:bg-slate-800/30 transition-colors">
                        {/* Dispute & Order */}
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-white flex items-center gap-1.5">
                            {d.id}
                            {d.is_high_value && (
                              <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                &gt;$250
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 font-mono">
                            {d.paypal_dispute_id} · {d.order_id}
                          </div>
                        </td>

                        {/* Customer */}
                        <td className="py-3.5 px-4">
                          <div className="text-slate-200 font-medium">{d.customer_name || 'Buyer'}</div>
                          <div className="text-xs text-slate-400 truncate max-w-[160px]">{d.customer_email || '—'}</div>
                        </td>

                        {/* Reason & Amount */}
                        <td className="py-3.5 px-4">
                          <div className="font-bold text-white text-base">{amountFormatted}</div>
                          <div className="text-xs text-slate-400 truncate max-w-[180px]" title={d.reason_code}>
                            {d.reason_code === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
                              ? 'Item Not Received'
                              : d.reason_code === 'SIGNIFICANTLY_NOT_AS_DESCRIBED'
                              ? 'Not as Described'
                              : d.reason_code}
                          </div>
                        </td>

                        {/* Status & Track */}
                        <td className="py-3.5 px-4">
                          <span className={`inline-block px-2.5 py-1 rounded-md text-xs border ${statusBadgeClass}`}>
                            {d.status}
                          </span>
                          {d.track && (
                            <div className="text-[11px] text-slate-400 mt-1 font-mono">
                              {d.track.replace('TRACK_', 'Track ')}
                            </div>
                          )}
                        </td>

                        {/* SLA Deadline Badge */}
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border font-medium ${slaBadgeClass}`}>
                            <Clock className="h-3 w-3" />
                            {slaLabel}
                          </span>
                          <div className="text-[10px] text-slate-400 mt-1">
                            Due: {new Date(d.seller_response_due_at).toLocaleDateString()}
                          </div>
                        </td>

                        {/* AI Recommendation */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5 text-blue-400" />
                            <span className="font-semibold text-slate-200 text-xs">
                              {d.recommended_action || 'AUTO_EVALUATE'}
                            </span>
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            Win Prob: <span className="font-medium text-emerald-400">{winPct}</span>
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {d.status === 'NEGOTIATING' && (
                              <Link
                                href={`/negotiate/${d.id}`}
                                className="px-2.5 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 text-xs font-medium transition inline-flex items-center gap-1"
                              >
                                <MessageSquare className="h-3 w-3" />
                                Portal
                              </Link>
                            )}

                            <Link
                              href={`/disputes/${d.id}`}
                              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition inline-flex items-center gap-1 shadow-sm"
                            >
                              Inspect
                              <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
