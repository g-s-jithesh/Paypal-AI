/**
 * ChargebackShield — Buyer Negotiation Chat & Prompt Injection Firewall Endpoint
 * Code-level enforcement of BR-004, BR-020, and 3-Layer Injection Defense (M4)
 */

import { NextResponse } from 'next/server';
import { getDb, runTransaction } from '@/lib/db';
import {
  sanitizeBuyerInput,
  scanBase64Payloads,
  ADVERSARIAL_PATTERNS,
} from '@/lib/firewall/injection-defense';
import { validateSettlementOffer, calculateRefundCap } from '@/lib/firewall/policy-firewall';
import { recordFirewallAuditLog } from '@/lib/firewall/audit-logger';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const rawText = (body.text || '').trim();

    if (!rawText) {
      return NextResponse.json({ error: 'Message text is required' }, { status: 400 });
    }

    const db = getDb();

    // 1. Fetch Dispute & Active Session
    const dispute = db.prepare(`
      SELECT d.*, o.amount_cents as order_amount_cents
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE d.id = ? OR d.paypal_dispute_id = ?
    `).get(id, id) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute ${id} not found` }, { status: 404 });
    }

    const session = db.prepare(`
      SELECT * FROM negotiation_sessions
      WHERE dispute_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(dispute.id) as any;

    if (!session) {
      return NextResponse.json({ error: 'No negotiation session found' }, { status: 404 });
    }

    let messages: any[] = [];
    try {
      messages = JSON.parse(session.messages_json || '[]');
    } catch {
      messages = [];
    }

    // 2. Layer 1: Prompt Boundary Sanitize & Adversarial Pattern Match
    const sanitization = sanitizeBuyerInput(rawText);
    const base64Matches = scanBase64Payloads(rawText);
    const allMatches = [...sanitization.matchedPatterns, ...base64Matches];
    const isAdversarial = sanitization.adversarialDetected || allMatches.length > 0;

    // Detect dollar / refund amount in text (e.g., "$42.00", "$120", "refund $50", "42 dollars")
    let requestedCents: number | null = null;
    const dollarMatch = rawText.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
    const amountMatch = rawText.match(/(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd|cents|refund)/i);

    if (dollarMatch) {
      requestedCents = Math.round(parseFloat(dollarMatch[1]) * 100);
    } else if (amountMatch) {
      requestedCents = Math.round(parseFloat(amountMatch[1]) * 100);
    } else if (/100%|full\s+refund/i.test(rawText)) {
      requestedCents = dispute.dispute_amount_cents;
    }

    const maxCapCents = calculateRefundCap(dispute.dispute_amount_cents, 0.40);

    let firewallIntercepted = false;
    let clamped = false;
    let interceptReason: string | undefined;
    let agentReplyText = '';
    let offerProposed: any = null;

    if (isAdversarial) {
      // PROMPT INJECTION / ADVERSARIAL ATTACK INTERCEPTED
      firewallIntercepted = true;
      interceptReason = 'PROMPT_INJECTION_DEFENSE';

      runTransaction((conn) => {
        conn.prepare(`
          UPDATE negotiation_sessions
          SET guardrail_triggered_count = guardrail_triggered_count + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(session.id);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'negotiation_sessions',
          entityId: session.id,
          action: 'PROMPT_INJECTION_DEFENSE',
          actorId: 'ACT-04',
          actorType: 'AI_AGENT',
          newStateJson: {
            requested_text: rawText,
            matched_patterns: allMatches.map((m) => m.patternName),
            clamped_cents: maxCapCents,
          },
          ruleIdsChecked: ['BR-004', 'BR-020'],
          guardrailStatus: 'BLOCKED',
        }, conn);
      }, db);

      agentReplyText = `🛡️ Firewall Alert: Prompt injection attempt intercepted and neutralized. System instructions cannot be altered. Our merchant resolution policy caps partial refunds at $${(maxCapCents / 100).toFixed(2)} (40% maximum per BR-004).`;
    } else if (requestedCents !== null) {
      // CHECK POLICY CAP (BR-004)
      const firewallCheck = validateSettlementOffer(dispute.dispute_amount_cents, requestedCents, 0.40);

      if (!firewallCheck.allowed || firewallCheck.clamped) {
        // Exceeds Cap -> Clamp strictly to 40%
        firewallIntercepted = true;
        clamped = true;
        interceptReason = 'EXCEEDS_POLICY_CAP';

        runTransaction((conn) => {
          conn.prepare(`
            UPDATE negotiation_sessions
            SET guardrail_triggered_count = guardrail_triggered_count + 1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?
          `).run(session.id);

          recordFirewallAuditLog({
            merchantId: dispute.merchant_id,
            entityType: 'negotiation_sessions',
            entityId: session.id,
            action: 'PROMPT_INJECTION_DEFENSE',
            actorId: 'ACT-04',
            actorType: 'AI_AGENT',
            newStateJson: {
              requested_cents: requestedCents,
              clamped_cents: firewallCheck.final_amount_cents,
              reason: 'EXCEEDS_POLICY_CAP',
            },
            ruleIdsChecked: ['BR-004'],
            guardrailStatus: 'BLOCKED',
          }, conn);
        }, db);

        agentReplyText = `⚠️ Your requested amount of $${(requestedCents / 100).toFixed(2)} exceeds our maximum pre-escalation refund cap of $${(firewallCheck.final_amount_cents / 100).toFixed(2)} (40% of dispute amount under BR-004). The MCP Policy Firewall has clamped this proposal to the policy maximum of $${(firewallCheck.final_amount_cents / 100).toFixed(2)}.`;

        // Propose clamped offer
        const offerId = `off_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        runTransaction((conn) => {
          conn.prepare(`
            UPDATE settlement_offers SET status = 'CANCELLED' WHERE dispute_id = ? AND status = 'PROPOSED'
          `).run(dispute.id);

          conn.prepare(`
            INSERT INTO settlement_offers (
              id, dispute_id, negotiation_session_id, offer_type, offered_amount_cents,
              max_allowed_cents, status, proposed_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'PARTIAL_REFUND', ?, ?, 'PROPOSED', 'AGENT', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          `).run(offerId, dispute.id, session.id, firewallCheck.final_amount_cents, maxCapCents);
        }, db);

        offerProposed = {
          id: offerId,
          offered_amount_cents: firewallCheck.final_amount_cents,
          status: 'PROPOSED',
          max_allowed_cents: maxCapCents,
        };
      } else {
        // Offer is within policy cap! Propose offer.
        const offerId = `off_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        runTransaction((conn) => {
          conn.prepare(`
            UPDATE settlement_offers SET status = 'CANCELLED' WHERE dispute_id = ? AND status = 'PROPOSED'
          `).run(dispute.id);

          conn.prepare(`
            INSERT INTO settlement_offers (
              id, dispute_id, negotiation_session_id, offer_type, offered_amount_cents,
              max_allowed_cents, status, proposed_by, created_at, updated_at
            ) VALUES (?, ?, ?, 'PARTIAL_REFUND', ?, ?, 'PROPOSED', 'AGENT', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          `).run(offerId, dispute.id, session.id, requestedCents, maxCapCents);
        }, db);

        offerProposed = {
          id: offerId,
          offered_amount_cents: requestedCents,
          status: 'PROPOSED',
          max_allowed_cents: maxCapCents,
        };

        agentReplyText = `✅ We can accept a partial settlement refund of $${(requestedCents / 100).toFixed(2)}. Please confirm below to immediately receive this refund and close this dispute.`;
      }
    } else {
      // General customer inquiry
      agentReplyText = `Thank you for your message. We want to resolve this smoothly. As a merchant courtesy, we can offer an immediate partial refund up to $${(maxCapCents / 100).toFixed(2)} (40% policy cap). Would you like to settle at this amount?`;
    }

    // 3. Append messages to session
    const buyerMsg = {
      id: `msg_${Date.now()}_buyer`,
      sender: 'BUYER',
      text: sanitization.sanitizedPrompt,
      timestamp: new Date().toISOString(),
    };

    const agentMsg = {
      id: `msg_${Date.now()}_agent`,
      sender: 'AGENT',
      text: agentReplyText,
      firewall_intercepted: firewallIntercepted,
      intercept_reason: interceptReason,
      timestamp: new Date().toISOString(),
      offer: offerProposed,
    };

    messages.push(buyerMsg, agentMsg);

    runTransaction((conn) => {
      conn.prepare(`
        UPDATE negotiation_sessions
        SET messages_json = ?,
            last_buyer_activity_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(JSON.stringify(messages), session.id);
    }, db);

    // Refresh session record to return updated guardrail count
    const updatedSession = db.prepare(`SELECT guardrail_triggered_count FROM negotiation_sessions WHERE id = ?`).get(session.id) as any;

    return NextResponse.json({
      success: true,
      firewall_intercepted: firewallIntercepted,
      clamped,
      intercept_reason: interceptReason,
      buyer_message: buyerMsg,
      agent_reply: agentMsg,
      offer_proposed: offerProposed,
      guardrail_triggered_count: updatedSession.guardrail_triggered_count,
    });
  } catch (err: any) {
    console.error('Buyer Chat Message Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
