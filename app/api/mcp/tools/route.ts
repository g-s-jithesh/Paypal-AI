/**
 * ChargebackShield — Model Context Protocol (MCP) Tool Executor
 * Guarded by Deterministic MCP Policy Firewall (BR-004, BR-006, BR-017)
 */

import { NextResponse } from 'next/server';
import { getDb, runTransaction } from '@/lib/db';
import { getPayPalClient } from '@/lib/paypal';
import { evaluatePolicyFirewall, loadMerchantPolicy } from '@/lib/firewall/policy-firewall';
import { TERMINAL_STATUSES } from '@/lib/engine/decision-router';
import { recordFirewallAuditLog } from '@/lib/firewall/audit-logger';

const MCP_TOOL_DEFINITIONS = [
  {
    name: 'make-offer',
    description: 'Propose a partial settlement refund offer to a disputing buyer, strictly bounded by the merchant Policy Firewall (BR-004).',
    inputSchema: {
      type: 'object',
      properties: {
        dispute_id: { type: 'string', description: 'Internal or PayPal dispute identifier' },
        offer_amount_cents: { type: 'integer', description: 'Proposed settlement refund amount in integer USD cents' },
        rationale: { type: 'string', description: 'Customer-facing settlement proposal rationale' },
      },
      required: ['dispute_id', 'offer_amount_cents'],
    },
  },
  {
    name: 'provide-evidence',
    description: 'Submit verified evidence documents and carrier tracking info to PayPal to challenge a dispute.',
    inputSchema: {
      type: 'object',
      properties: {
        dispute_id: { type: 'string', description: 'Dispute identifier' },
        evidence_type: { type: 'string', description: 'Type of evidence (e.g. PROOF_OF_DELIVERY, USAGE_LOG)' },
        notes: { type: 'string', description: 'Supporting evidence notes' },
        tracking_number: { type: 'string', description: 'Carrier tracking number' },
        carrier: { type: 'string', description: 'Shipping carrier name' },
      },
      required: ['dispute_id'],
    },
  },
  {
    name: 'accept-claim',
    description: 'Auto-accept dispute claim and issue full refund to avoid escalation fees.',
    inputSchema: {
      type: 'object',
      properties: {
        dispute_id: { type: 'string', description: 'Dispute identifier' },
        reason: { type: 'string', description: 'Settlement reason or note' },
      },
      required: ['dispute_id'],
    },
  },
];

export async function GET() {
  return NextResponse.json({
    tools: MCP_TOOL_DEFINITIONS,
    guardrails: {
      firewall_active: true,
      rules_enforced: ['BR-004', 'BR-006', 'BR-014', 'BR-017'],
      max_refund_cap_pct: 0.40,
      high_value_gate_cents: 25000,
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const toolName = body.tool || body.name;
    const args = body.arguments || body.args || {};

    if (!MCP_TOOL_DEFINITIONS.some((t) => t.name === toolName)) {
      return NextResponse.json({ error: `Unknown tool: ${toolName}` }, { status: 400 });
    }

    const db = getDb();
    const paypalClient = getPayPalClient();

    const disputeId = args.dispute_id;
    const dispute = db.prepare(`
      SELECT d.*, o.amount_cents as order_amount_cents
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE d.id = ? OR d.paypal_dispute_id = ?
    `).get(disputeId, disputeId) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute ${disputeId} not found` }, { status: 404 });
    }

    // BR-005: checked before any PayPal call so terminal disputes never trigger external side effects
    if (TERMINAL_STATUSES.includes(dispute.status)) {
      return NextResponse.json({
        success: false,
        tool: toolName,
        error: 'DISPUTE_TERMINAL',
        reason: `Dispute ${dispute.id} is ${dispute.status} and cannot be modified (BR-005)`,
      }, { status: 409 });
    }

    // BR-006 / BR-017: the agent may only submit evidence up to the human-review gate,
    // and only concede claims up to the auto-accept ceiling. Above that, a human decides.
    if (toolName !== 'make-offer') {
      const policy = loadMerchantPolicy(dispute.merchant_id, db);
      const isAccept = toolName === 'accept-claim';
      const limitCents = isAccept ? policy.auto_accept_below_cents : policy.max_auto_dispute_cents;
      const ruleId = isAccept ? 'BR-017' : 'BR-006';

      if (dispute.dispute_amount_cents > limitCents) {
        runTransaction((conn) => {
          conn.prepare(`
            UPDATE disputes
            SET status = 'READY_FOR_REVIEW', track = 'TRACK_D_HUMAN_REVIEW', version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).run(dispute.id);
          recordFirewallAuditLog({
            merchantId: dispute.merchant_id,
            entityType: 'disputes',
            entityId: dispute.id,
            action: 'HUMAN_REVIEW_REQUIRED',
            actorId: 'ACT-04',
            actorType: 'AI_AGENT',
            newStateJson: { tool: toolName, dispute_amount_cents: dispute.dispute_amount_cents, limit_cents: limitCents },
            ruleIdsChecked: [ruleId],
            guardrailStatus: 'BLOCKED',
          }, conn);
        }, db);

        return NextResponse.json({
          success: false,
          tool: toolName,
          error: 'HUMAN_REVIEW_REQUIRED',
          reason: `Dispute amount $${(dispute.dispute_amount_cents / 100).toFixed(2)} exceeds the $${(limitCents / 100).toFixed(2)} autonomous limit for ${toolName} (${ruleId})`,
          rule_id: ruleId,
          status: 'READY_FOR_REVIEW',
          track: 'TRACK_D_HUMAN_REVIEW',
        }, { status: 403 });
      }
    }

    // 1. Tool: make-offer
    if (toolName === 'make-offer') {
      const offeredCents = Math.round(Number(args.offer_amount_cents || 0));

      // Check cumulative refunded cents
      const priorOffers = db.prepare(`
        SELECT COALESCE(SUM(offered_amount_cents), 0) as total_refunded
        FROM settlement_offers
        WHERE dispute_id = ? AND status IN ('ACCEPTED', 'EXECUTED')
      `).get(dispute.id) as { total_refunded: number };

      // Evaluate Code-Level Policy Firewall
      const firewallResult = evaluatePolicyFirewall({
        merchantId: dispute.merchant_id,
        disputeId: dispute.id,
        disputeAmountCents: dispute.dispute_amount_cents,
        offeredCents,
        orderAmountCents: dispute.order_amount_cents,
        cumulativeRefundedCents: priorOffers.total_refunded,
      }, db);

      // If High-Value Gate triggered (BR-006)
      if (firewallResult.reason === 'HIGH_VALUE_REQUIRES_HUMAN_REVIEW') {
        db.prepare(`
          UPDATE disputes
          SET status = 'READY_FOR_REVIEW', track = 'TRACK_D_HUMAN_REVIEW', version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(dispute.id);

        return NextResponse.json({
          success: false,
          tool: 'make-offer',
          allowed: false,
          clamped: false,
          error: 'HIGH_VALUE_GATE_TRIGGERED',
          reason: 'Dispute exceeds $250.00 human approval threshold (BR-006)',
          status: 'READY_FOR_REVIEW',
          track: 'TRACK_D_HUMAN_REVIEW',
        }, { status: 403 });
      }

      // If offer exceeded cap (BR-004)
      if (!firewallResult.allowed || firewallResult.clamped) {
        // Increment guardrail triggered count in active session
        db.prepare(`
          UPDATE negotiation_sessions
          SET guardrail_triggered_count = guardrail_triggered_count + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE dispute_id = ?
        `).run(dispute.id);

        return NextResponse.json({
          success: false,
          tool: 'make-offer',
          allowed: false,
          clamped: true,
          error: 'EXCEEDS_POLICY_CAP',
          original_amount_cents: offeredCents,
          final_amount_cents: firewallResult.final_amount_cents,
          max_allowed_cents: firewallResult.max_allowed_cents,
          reason: `Offer of $${(offeredCents / 100).toFixed(2)} exceeds merchant policy cap of $${(firewallResult.final_amount_cents / 100).toFixed(2)} (BR-004). Clamped to policy maximum.`,
          rule_id: 'BR-004',
        });
      }

      // Resolve the dispute's own session server-side (never trust a client-supplied session id)
      const session = db.prepare(`
        SELECT id FROM negotiation_sessions WHERE dispute_id = ? AND status = 'ACTIVE'
      `).get(dispute.id) as { id: string } | undefined;

      if (!session) {
        return NextResponse.json({
          success: false,
          tool: 'make-offer',
          error: 'NO_ACTIVE_NEGOTIATION_SESSION',
          reason: `Dispute ${dispute.id} has no active negotiation session`,
        }, { status: 409 });
      }

      // Valid offer -> Dispatch to PayPal Client & record in settlement_offers
      const paypalRes = await paypalClient.makeOffer(dispute.paypal_dispute_id || dispute.id, {
        amount_cents: offeredCents,
        note: args.rationale || 'ChargebackShield Autonomous Settlement Offer',
      });

      const offerId = `off_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      runTransaction((conn) => {
        conn.prepare(`
          INSERT INTO settlement_offers (
            id, dispute_id, negotiation_session_id, offer_type, offered_amount_cents,
            max_allowed_cents, status, paypal_offer_id, proposed_by, created_at, updated_at
          ) VALUES (?, ?, ?, 'PARTIAL_REFUND', ?, ?, 'PROPOSED', ?, 'AGENT', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(
          offerId,
          dispute.id,
          session.id,
          offeredCents,
          firewallResult.max_allowed_cents,
          paypalRes.paypal_reference_id
        );
      });

      return NextResponse.json({
        success: true,
        tool: 'make-offer',
        allowed: true,
        clamped: false,
        offer_id: offerId,
        offered_amount_cents: offeredCents,
        paypal_reference_id: paypalRes.paypal_reference_id,
        message: 'Settlement offer proposed and approved by Policy Firewall',
      });
    }

    // 2. Tool: provide-evidence
    if (toolName === 'provide-evidence') {
      const paypalRes = await paypalClient.provideEvidence(dispute.paypal_dispute_id || dispute.id, {
        evidence_type: args.evidence_type || 'PROOF_OF_DELIVERY',
        notes: args.notes,
        tracking_number: args.tracking_number,
        carrier: args.carrier,
      });

      runTransaction((conn) => {
        conn.prepare(`
          UPDATE disputes
          SET status = 'SUBMITTED', track = 'TRACK_A_AUTO_SUBMIT', submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(dispute.id);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'disputes',
          entityId: dispute.id,
          action: 'EVIDENCE_SUBMITTED_VIA_MCP',
          actorId: 'ACT-04',
          actorType: 'AI_AGENT',
          newStateJson: { status: 'SUBMITTED', reference: paypalRes.paypal_reference_id },
          ruleIdsChecked: ['BR-008', 'BR-016'],
          guardrailStatus: 'PASSED',
        }, conn);
      }, db);

      return NextResponse.json({
        success: true,
        tool: 'provide-evidence',
        dispute_id: dispute.id,
        status: 'SUBMITTED',
        paypal_reference_id: paypalRes.paypal_reference_id,
      });
    }

    // 3. Tool: accept-claim
    if (toolName === 'accept-claim') {
      const paypalRes = await paypalClient.acceptClaim(dispute.paypal_dispute_id || dispute.id, args.reason);

      runTransaction((conn) => {
        conn.prepare(`
          UPDATE disputes
          SET status = 'SETTLED_VIA_REFUND', track = 'TRACK_C_AUTO_ACCEPT', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(dispute.id);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'disputes',
          entityId: dispute.id,
          action: 'CLAIM_ACCEPTED_VIA_MCP',
          actorId: 'ACT-04',
          actorType: 'AI_AGENT',
          newStateJson: { status: 'SETTLED_VIA_REFUND', reference: paypalRes.paypal_reference_id },
          ruleIdsChecked: ['BR-017', 'BR-016'],
          guardrailStatus: 'PASSED',
        }, conn);
      }, db);

      return NextResponse.json({
        success: true,
        tool: 'accept-claim',
        dispute_id: dispute.id,
        status: 'SETTLED_VIA_REFUND',
        paypal_reference_id: paypalRes.paypal_reference_id,
      });
    }

    return NextResponse.json({ error: `Unknown tool: ${toolName}` }, { status: 400 });
  } catch (err: any) {
    console.error('MCP Tool Executor Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
