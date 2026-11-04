'use client';

import React, { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import {
  Shield,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  FileText,
  Truck,
  User,
  Hash,
  ExternalLink,
  RefreshCw,
  Send,
  Lock,
  MessageSquare,
  AlertCircle,
  Award,
  FileCheck,
} from 'lucide-react';

interface DisputeDetailData {
  dispute: {
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
    submitted_at: string | null;
    resolved_at: string | null;
    hours_remaining: number;
    sla_urgency: 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'NORMAL';
    is_high_value: boolean;
    requires_human_approval: boolean;
  };
  order: {
    id: string;
    amount_cents: number;
    currency: string;
    carrier_name: string | null;
    tracking_number: string | null;
    delivery_status: string;
    delivered_at: string | null;
    shipped_at: string | null;
    delivery_signature_name: string | null;
    item_summary: string;
    customer_name: string;
    customer_email: string;
    shipping_address_line1: string | null;
    shipping_city: string | null;
    shipping_country: string;
  };
  evidenceItems: Array<{
    id: string;
    evidence_type: string;
    source_system: string;
    title: string;
    content_json: string;
    sha256_hash: string;
    is_verified: number;
    verified_at: string | null;
    created_at: string;
  }>;
  assessment: {
    id: string;
    win_probability: number;
    expected_value_cents: number;
    ev_settle_cents: number;
    recommended_action: string;
    confidence_score: number;
    reasoning_json: string;
  } | null;
  negotiationSession: {
    id: string;
    status: string;
    max_refund_allowed_cents: number;
    guardrail_triggered_count: number;
  } | null;
  settlementOffers: Array<{
    id: string;
    offered_amount_cents: number;
    status: string;
    proposed_by: string;
    created_at: string;
  }>;
  auditLogs: Array<{
    id: string;
    action: string;
    actor_id: string;
    actor_type: string;
    guardrail_status: string;
    rule_ids_checked: string;
    created_at: string;
  }>;
}

export default function DisputeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<DisputeDetailData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [approving, setApproving] = useState<boolean>(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Evidence Verifier Sandbox Form State
  const [customTracking, setCustomTracking] = useState('');
  const [customCarrier, setCustomCarrier] = useState('');
  const [customDeliveryDate, setCustomDeliveryDate] = useState('');
  const [verifyingFact, setVerifyingFact] = useState(false);
  const [verificationFeedback, setVerificationFeedback] = useState<{
    verified: boolean;
    message: string;
    hash?: string;
  } | null>(null);

  const fetchDispute = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/disputes/${id}`);
      const json = await res.json();
      if (json.success) {
        setData(json);
        if (json.order) {
          setCustomTracking(json.order.tracking_number || '');
          setCustomCarrier(json.order.carrier_name || '');
          setCustomDeliveryDate(json.order.delivered_at || '');
        }
      }
    } catch (err) {
      console.error('Failed to fetch dispute detail:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDispute();
  }, [fetchDispute]);

  // 1-Click Analyst Approval Handler (BR-006)
  const handleAnalystApproval = async () => {
    try {
      setApproving(true);
      setActionSuccess(null);
      setActionError(null);

      const res = await fetch(`/api/disputes/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'APPROVE',
          notes: '1-click analyst review approval (BR-006)',
        }),
      });

      const result = await res.json();
      if (res.ok && result.success) {
        setActionSuccess(`Dispute approved! Status transitioned to SUBMITTED (PayPal Ref: ${result.paypal_reference_id || 'PP-TX-ACK'}).`);
        fetchDispute();
      } else {
        setActionError(result.error || 'Failed to submit approval.');
      }
    } catch (err: any) {
      setActionError(err.message || 'Network error.');
    } finally {
      setApproving(false);
    }
  };

  // 1-Click Auto-Assemble Evidence Package (< 15 seconds)
  const handleAutoAssemble = async () => {
    try {
      setLoading(true);
      setActionSuccess(null);
      setActionError(null);

      const res = await fetch(`/api/disputes/${id}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_assemble: true }),
      });

      const result = await res.json();
      if (res.ok && result.success) {
        setActionSuccess(`Evidence package auto-assembled and SHA-256 verified in < 15s (Hash: ${result.sha256_hash.substring(0, 16)}...).`);
        fetchDispute();
      } else {
        setActionError(result.error || 'Failed to auto-assemble evidence.');
      }
    } catch (err: any) {
      setActionError(err.message || 'Auto-assemble failed.');
    } finally {
      setLoading(false);
    }
  };

  // Test Verifier Ground Truth Check (BR-008 Zero-Hallucination)
  const handleVerifyGroundTruth = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyingFact(true);
    setVerificationFeedback(null);

    try {
      const payload = {
        tracking_number: customTracking.trim(),
        carrier_name: customCarrier.trim(),
        delivered_at: customDeliveryDate.trim(),
      };

      const res = await fetch(`/api/disputes/${id}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evidence_type: 'TRACKING_PROOF',
          title: 'Carrier Verification Probe',
          content: payload,
        }),
      });

      const result = await res.json();
      if (result.is_verified) {
        setVerificationFeedback({
          verified: true,
          message: 'Zero-Hallucination Check PASSED: Carrier facts strictly match Order Ground Truth.',
          hash: result.sha256_hash,
        });
        fetchDispute();
      } else {
        setVerificationFeedback({
          verified: false,
          message: `Zero-Hallucination Check BLOCKED: Ground truth mismatch (${result.error || 'HALLUCINATED_FACT'}). Fabricated facts are rejected by BR-008.`,
        });
      }
    } catch (err: any) {
      setVerificationFeedback({
        verified: false,
        message: err.message || 'Verification failed',
      });
    } finally {
      setVerifyingFact(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto text-blue-500 mb-3" />
          <p className="text-slate-400 text-sm">Loading dispute details &amp; evidence facts...</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-8 flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" />
          <h2 className="text-xl font-bold">Dispute Not Found</h2>
          <Link href="/disputes" className="mt-4 inline-block text-blue-400 hover:underline">
            &larr; Back to Dispute Queue
          </Link>
        </div>
      </div>
    );
  }

  const { dispute, order, evidenceItems, assessment, auditLogs, negotiationSession } = data;
  const isHighValue = dispute.dispute_amount_cents > 25000;
  const isPendingApproval = isHighValue && ['READY_FOR_REVIEW', 'OPEN', 'EVIDENCE_GATHERING'].includes(dispute.status);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/disputes"
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              title="Return to queue"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg text-white">{dispute.id}</span>
                <span className="text-xs px-2 py-0.5 rounded font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  {dispute.paypal_dispute_id}
                </span>
                {isHighValue && (
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    High-Value (&gt; $250, BR-006)
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-400">
              SLA Due in <strong className="text-slate-100">{dispute.hours_remaining}h</strong>
            </span>
            <div className="h-4 w-px bg-slate-800" />
            <Link
              href={`/negotiate/${dispute.id}`}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 border border-purple-500/30 transition flex items-center gap-1.5"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Buyer Negotiation Portal
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full space-y-6">
        {/* Success / Error Alerts */}
        {actionSuccess && (
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-center gap-3 shadow-lg">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0" />
            <p className="text-sm font-medium">{actionSuccess}</p>
          </div>
        )}

        {actionError && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 flex items-center gap-3 shadow-lg">
            <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
            <p className="text-sm font-medium">{actionError}</p>
          </div>
        )}

        {/* BR-006 High-Value Human Approval Banner */}
        {isPendingApproval && (
          <div className="p-5 rounded-xl bg-gradient-to-r from-amber-950/60 via-amber-900/30 to-slate-900 border border-amber-500/40 shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="p-2.5 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 flex-shrink-0">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-amber-200 text-base flex items-center gap-2">
                  High-Value Dispute Approval Required (BR-006)
                </h3>
                <p className="text-xs text-amber-300/80 mt-1 max-w-2xl leading-relaxed">
                  Dispute amount <strong>${(dispute.dispute_amount_cents / 100).toFixed(2)}</strong> exceeds the $250.00 autonomous threshold. Per merchant risk policy, this dispute requires 1-click human analyst sign-off before formal evidence submission to PayPal.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleAnalystApproval}
                disabled={approving}
                className="w-full sm:w-auto px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm transition shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2"
              >
                {approving ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                1-Click Approve &amp; Submit (ACT-01)
              </button>
            </div>
          </div>
        )}

        {/* 3-Column Workstation Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Column 1: Order Ground Truth & Fulfillment Timeline (4 cols) */}
          <div className="lg:col-span-4 space-y-6">
            {/* Order Ground Truth Card */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4 text-blue-400" />
                  Order Ground Truth
                </h3>
                <span className="text-xs font-mono text-slate-400">{order.id}</span>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <span className="text-slate-400 block mb-0.5">Customer</span>
                  <div className="font-medium text-slate-200 text-sm">{order.customer_name}</div>
                  <div className="text-slate-400">{order.customer_email}</div>
                </div>

                <div>
                  <span className="text-slate-400 block mb-0.5">Purchased Item</span>
                  <div className="font-medium text-slate-200">{order.item_summary}</div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800/60">
                  <div>
                    <span className="text-slate-400 block mb-0.5">Order Amount</span>
                    <div className="font-bold text-white text-base">
                      ${(order.amount_cents / 100).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-400 block mb-0.5">Disputed Amount</span>
                    <div className="font-bold text-amber-400 text-base">
                      ${(dispute.dispute_amount_cents / 100).toFixed(2)}
                    </div>
                  </div>
                </div>

                {order.shipping_address_line1 && (
                  <div className="pt-2 border-t border-slate-800/60">
                    <span className="text-slate-400 block mb-0.5">Destination</span>
                    <div className="text-slate-300">
                      {order.shipping_address_line1}, {order.shipping_city}, {order.shipping_country}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Carrier Fulfillment Timeline Card */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                  <Truck className="h-4 w-4 text-emerald-400" />
                  Carrier Tracking Timeline
                </h3>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {order.delivery_status}
                </span>
              </div>

              <div className="space-y-3.5 text-xs">
                <div>
                  <span className="text-slate-400 block mb-0.5">Shipping Carrier</span>
                  <div className="font-semibold text-slate-200 text-sm flex items-center gap-1.5">
                    {order.carrier_name || 'Carrier Unspecified'}
                  </div>
                </div>

                <div>
                  <span className="text-slate-400 block mb-0.5">Tracking Number</span>
                  <div className="font-mono text-xs px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-slate-200 select-all">
                    {order.tracking_number || 'No tracking available'}
                  </div>
                </div>

                {order.delivered_at && (
                  <div>
                    <span className="text-slate-400 block mb-0.5">Delivered Timestamp</span>
                    <div className="font-mono text-xs text-slate-200">
                      {new Date(order.delivered_at).toUTCString()}
                    </div>
                  </div>
                )}

                {order.delivery_signature_name && (
                  <div className="pt-2 border-t border-slate-800/60">
                    <span className="text-slate-400 block mb-0.5">Confirmed Delivery Signer</span>
                    <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 flex items-center gap-2">
                      <FileCheck className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                      <span className="font-semibold text-sm">{order.delivery_signature_name}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Column 2: Evidence Auto-Assembler & SHA-256 Verifier (5 cols) */}
          <div className="lg:col-span-5 space-y-6">
            {/* Auto-Assembler Quick Action Card */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-400" />
                  Evidence Auto-Assembler (G6 &lt; 15s)
                </h3>
                <span className="text-[10px] uppercase font-bold text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded border border-blue-500/30">
                  BR-008
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Automatically aggregate carrier delivery proof, order invoice, and signer confirmation into a canonical JSON payload with SHA-256 cryptographic digest.
              </p>

              <button
                onClick={handleAutoAssemble}
                className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition shadow-md shadow-blue-600/20 flex items-center justify-center gap-2"
              >
                <Sparkles className="h-4 w-4" />
                Auto-Assemble &amp; Verify Package
              </button>
            </div>

            {/* Zero-Hallucination Fact Verifier (BR-008) */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                  <Award className="h-4 w-4 text-amber-400" />
                  SHA-256 Zero-Hallucination Verifier
                </h3>
                <span className="text-xs text-slate-400 font-mono">Fact-Check Gate</span>
              </div>

              <p className="text-xs text-slate-400">
                Tests ground truth matching. Any hallucinated tracking numbers or falsified delivery dates are rejected.
              </p>

              <form onSubmit={handleVerifyGroundTruth} className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Carrier Tracking Number</label>
                  <input
                    type="text"
                    value={customTracking}
                    onChange={(e) => setCustomTracking(e.target.value)}
                    placeholder="Enter tracking number..."
                    className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Carrier Name</label>
                    <input
                      type="text"
                      value={customCarrier}
                      onChange={(e) => setCustomCarrier(e.target.value)}
                      placeholder="e.g. UPS, FedEx"
                      className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Delivered Timestamp</label>
                    <input
                      type="text"
                      value={customDeliveryDate}
                      onChange={(e) => setCustomDeliveryDate(e.target.value)}
                      placeholder="ISO timestamp"
                      className="w-full px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={verifyingFact}
                  className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition flex items-center justify-center gap-1.5"
                >
                  {verifyingFact ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileCheck className="h-3.5 w-3.5 text-blue-400" />
                  )}
                  Verify Evidence Facts against DB Ground Truth
                </button>
              </form>

              {/* Feedback Alert */}
              {verificationFeedback && (
                <div
                  className={`p-3 rounded-lg border text-xs leading-relaxed ${
                    verificationFeedback.verified
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : 'bg-red-500/10 border-red-500/30 text-red-300'
                  }`}
                >
                  <div className="font-semibold mb-1">{verificationFeedback.message}</div>
                  {verificationFeedback.hash && (
                    <div className="font-mono text-[10px] break-all text-emerald-400/80">
                      SHA-256 Digest: {verificationFeedback.hash}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Assembled Evidence Items List */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                <h4 className="font-semibold text-white text-xs">
                  Verified Evidence Package ({evidenceItems.length} items)
                </h4>
              </div>

              {evidenceItems.length === 0 ? (
                <p className="text-xs text-slate-500 py-3 text-center">
                  No evidence items compiled yet. Click Auto-Assemble above.
                </p>
              ) : (
                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                  {evidenceItems.map((item) => (
                    <div
                      key={item.id}
                      className="p-3 rounded-lg bg-slate-950/80 border border-slate-800/80 space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-200 text-xs">{item.title}</span>
                        <span
                          className={`text-[10px] px-2 py-0.2 rounded font-semibold ${
                            item.is_verified === 1
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-red-500/20 text-red-300 border border-red-500/30'
                          }`}
                        >
                          {item.is_verified === 1 ? '✓ VERIFIED' : 'UNVERIFIED'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                        <span>{item.evidence_type}</span>
                        <span>{item.source_system}</span>
                      </div>
                      <div className="font-mono text-[10px] text-slate-500 break-all bg-slate-900 px-2 py-1 rounded">
                        SHA-256: {item.sha256_hash}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Column 3: AI Engine Assessment & Audit Trail (3 cols) */}
          <div className="lg:col-span-3 space-y-6">
            {/* AI Assessment Card */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4 shadow-lg">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-400" />
                  AI Decision Engine
                </h3>
              </div>

              {assessment ? (
                <div className="space-y-3.5 text-xs">
                  <div>
                    <span className="text-slate-400 block mb-1">Win Probability (W)</span>
                    <div className="flex items-center gap-3">
                      <div className="text-3xl font-black text-emerald-400">
                        {Math.round(assessment.win_probability * 100)}%
                      </div>
                      <div className="flex-1 bg-slate-950 h-2.5 rounded-full overflow-hidden border border-slate-800">
                        <div
                          className="bg-emerald-500 h-full rounded-full"
                          style={{ width: `${assessment.win_probability * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/60">
                    <div>
                      <span className="text-slate-400 block mb-0.5">EV Compete</span>
                      <div className="font-bold text-slate-200">
                        ${(assessment.expected_value_cents / 100).toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 block mb-0.5">EV Settle</span>
                      <div className="font-bold text-slate-200">
                        ${(assessment.ev_settle_cents / 100).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/60">
                    <span className="text-slate-400 block mb-1">Step 18 Action Matrix</span>
                    <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 font-semibold text-center">
                      {assessment.recommended_action}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500 py-4 text-center">
                  No automated assessment on file.
                </p>
              )}
            </div>

            {/* Audit Trail Log */}
            <div className="p-5 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3 shadow-lg">
              <h3 className="font-semibold text-white text-xs border-b border-slate-800/80 pb-2 flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-slate-400" />
                Immutable Audit Trail (ENT-09)
              </h3>

              <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                {auditLogs.map((log) => (
                  <div key={log.id} className="text-[11px] p-2 rounded bg-slate-950/60 border border-slate-800/60 space-y-1">
                    <div className="flex items-center justify-between font-semibold text-slate-200">
                      <span>{log.action}</span>
                      <span
                        className={`text-[9px] px-1.5 py-0.2 rounded ${
                          log.guardrail_status === 'PASSED'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-red-500/20 text-red-400'
                        }`}
                      >
                        {log.guardrail_status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-slate-500 text-[10px]">
                      <span>Actor: {log.actor_id}</span>
                      <span>{new Date(log.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
