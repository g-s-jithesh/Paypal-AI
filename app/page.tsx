import Link from 'next/link';
import {
  Shield,
  FileCheck,
  MessageSquare,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Lock,
} from 'lucide-react';

export default function HomePage() {
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
                AI Autopilot
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link
              href="/disputes"
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition flex items-center gap-1.5 shadow-md shadow-blue-600/20"
            >
              <FileCheck className="h-4 w-4" />
              Open Dispute Workbench
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex-1 w-full space-y-12">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 text-blue-400 text-xs font-semibold border border-blue-500/20">
            <Lock className="h-3.5 w-3.5" />
            Talencia Global DDDL v1.0 Certified · Production-Ready
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white leading-tight">
            Autonomous AI Dispute &amp; Refund Autopilot for PayPal
          </h1>
          <p className="text-base sm:text-lg text-slate-400 leading-relaxed">
            Protect merchant revenue, eliminate chargeback fees, and settle inquiries autonomously using mathematical Expected Value ($EV$), SHA-256 Zero-Hallucination evidence verification, and deterministic MCP Policy Firewalls.
          </p>
        </div>

        {/* Action Gateways Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {/* Dispute Workbench Card */}
          <Link
            href="/disputes"
            className="group p-6 rounded-2xl bg-slate-900/70 border border-slate-800 hover:border-blue-500/50 hover:bg-slate-900 transition-all shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-4">
              <div className="h-12 w-12 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                <FileCheck className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg text-white group-hover:text-blue-400 transition-colors">
                Dispute Autopilot Workbench
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Filter and inspect the active dispute pipeline with real-time SLA countdown badges, carrier tracking timelines, and delivery signatures.
              </p>
            </div>
            <div className="mt-6 flex items-center gap-2 text-xs font-semibold text-blue-400 group-hover:translate-x-1 transition-transform">
              Launch Workbench <ArrowRight className="h-4 w-4" />
            </div>
          </Link>

          {/* Evidence Verifier Card */}
          <Link
            href="/disputes/DSP-GOLD-004"
            className="group p-6 rounded-2xl bg-slate-900/70 border border-amber-500/20 hover:border-amber-500/50 hover:bg-slate-900 transition-all shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-4">
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/30 flex items-center justify-center group-hover:scale-105 transition-transform">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg text-white group-hover:text-amber-400 transition-colors">
                High-Value Approval Gate
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Demonstrates BR-006: 1-click analyst approval workflow for high-value disputes (&gt; $250.00) with SHA-256 zero-hallucination fact verification.
              </p>
            </div>
            <div className="mt-6 flex items-center gap-2 text-xs font-semibold text-amber-400 group-hover:translate-x-1 transition-transform">
              Test DSP-GOLD-004 ($450) <ArrowRight className="h-4 w-4" />
            </div>
          </Link>

          {/* Buyer Negotiation Portal Card */}
          <Link
            href="/negotiate/DSP-GOLD-003"
            className="group p-6 rounded-2xl bg-slate-900/70 border border-purple-500/20 hover:border-purple-500/50 hover:bg-slate-900 transition-all shadow-xl flex flex-col justify-between"
          >
            <div className="space-y-4">
              <div className="h-12 w-12 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/30 flex items-center justify-center group-hover:scale-105 transition-transform">
                <MessageSquare className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg text-white group-hover:text-purple-400 transition-colors">
                Buyer Negotiation Portal
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Experience real-time settlement negotiation with MCP Policy Firewall interception badges and 40% refund cap clamping (BR-004 / BR-020).
              </p>
            </div>
            <div className="mt-6 flex items-center gap-2 text-xs font-semibold text-purple-400 group-hover:translate-x-1 transition-transform">
              Open Buyer Chat (DSP-GOLD-003) <ArrowRight className="h-4 w-4" />
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}
