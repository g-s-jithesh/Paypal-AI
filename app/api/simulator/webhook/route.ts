/**
 * ChargebackShield — Simulator Synthetic Webhook Dispatcher
 * Trigger synthetic PayPal Dispute webhooks for Golden Personas
 */

import { NextResponse } from 'next/server';
import { GOLDEN_PERSONAS } from '@/lib/paypal/simulator';
import { getDb, runTransaction } from '@/lib/db';
import { evaluateWinProbabilityFactors } from '@/lib/engine/win-probability';
import { calculateAllEvs } from '@/lib/engine/ev-engine';
import { routeStep18 } from '@/lib/engine/decision-router';
import { loadPolicyDecisionInputs } from '@/lib/firewall/policy-firewall';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const persona = body.persona || 'DSP-GOLD-001';

    const personaConfig = GOLDEN_PERSONAS[persona] || GOLDEN_PERSONAS['PP-D-GOLD-001'];
    const transmissionId = `WH-SIM-TX-${persona}-${Date.now()}`;
    const disputeId = persona.startsWith('PP-') ? persona : `PP-D-${persona}`;
    const amountVal = personaConfig.dispute_amount?.value || '145.00';
    const amountCents = Math.round(parseFloat(amountVal) * 100);
    const reasonCode = personaConfig.reason || 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';

    const db = getDb();

    // Look up or establish matching order
    let order = db.prepare('SELECT * FROM orders WHERE paypal_order_id = ? OR id = ?').get(persona, persona) as any;
    if (!order) {
      order = db.prepare('SELECT * FROM orders LIMIT 1').get() as any;
    }

    const orderId = order ? order.id : 'ORD-INT-01';
    const merchantId = order ? order.merchant_id : 'merch_default';
    const deliveryStatus = order ? order.delivery_status : 'DELIVERED';

    const webhookPayload = {
      id: transmissionId,
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      create_time: new Date().toISOString(),
      resource_type: 'dispute',
      resource: {
        dispute_id: disputeId,
        dispute_amount: { currency_code: 'USD', value: amountVal },
        reason: reasonCode,
        status: 'WAITING_FOR_SELLER_RESPONSE',
        seller_response_due_date: new Date(Date.now() + 864000000).toISOString(),
        disputed_transactions: [
          {
            seller_transaction_id: orderId,
            gross_amount: { currency_code: 'USD', value: amountVal },
            buyer: { name: order?.customer_name || 'Golden Buyer', email: order?.customer_email || 'buyer@golden.com' },
          },
        ],
      },
    };

    // Execute atomic ingestion & routing
    const result = runTransaction((conn) => {
      // 1. Record webhook event
      conn.prepare(`
        INSERT INTO webhook_events (
          id, webhook_id, event_type, resource_id, payload_json, processing_status, created_at
        ) VALUES (?, ?, 'CUSTOMER.DISPUTE.CREATED', ?, ?, 'PROCESSED', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        `wh_sim_${Date.now()}`,
        transmissionId,
        disputeId,
        JSON.stringify(webhookPayload)
      );

      // 2. Score Win Probability & EV
      const winResult = evaluateWinProbabilityFactors({
        reasonCode,
        deliveryStatus,
        hasSignature: Boolean(order?.delivery_signature_name),
        hasDeliveryProof: deliveryStatus === 'DELIVERED',
        hasCarrierTrackingConfirmed: Boolean(order?.tracking_number),
      });

      const policyInputs = loadPolicyDecisionInputs(merchantId, conn);
      const evResult = calculateAllEvs({
        ...policyInputs,
        winProbability: winResult.winProbability,
        disputeAmountCents: amountCents,
      });

      const decision = routeStep18({
        ...policyInputs,
        disputeAmountCents: amountCents,
        reasonCode,
        deliveryProof: winResult.factors.hasDeliveryProof ?? false,
        deliveryStatus,
        winProbability: winResult.winProbability,
        evCompeteCents: evResult.evCompeteCents,
        evSettleCents: evResult.evSettleCents,
      });

      // 3. Upsert Dispute
      const existing = conn.prepare('SELECT id, version FROM disputes WHERE paypal_dispute_id = ?').get(disputeId) as any;
      let finalDisputeId = existing?.id;

      if (existing) {
        conn.prepare(`
          UPDATE disputes
          SET status = ?, track = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND status NOT IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
        `).run(decision.nextStatus, decision.track, existing.id);
      } else {
        finalDisputeId = `DSP-SIM-${Date.now()}`;
        conn.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
            dispute_amount_cents, currency, seller_response_due_at, stage, track, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'INQUIRY', ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(
          finalDisputeId,
          merchantId,
          orderId,
          disputeId,
          reasonCode,
          decision.nextStatus,
          amountCents,
          webhookPayload.resource.seller_response_due_date,
          decision.track
        );
      }

      // 4. Log AI Assessment
      conn.prepare(`
        INSERT INTO ai_assessments (
          id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
          recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gemini-1.5-flash-chargeback-v1', 12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        `asm_sim_${Date.now()}`,
        finalDisputeId,
        winResult.winProbability,
        evResult.evCompeteCents,
        evResult.evSettleCents,
        decision.action,
        winResult.confidenceScore,
        JSON.stringify({ rule_id: decision.ruleId, rationale: decision.rationale })
      );

      // 5. Log Audit Record
      conn.prepare(`
        INSERT INTO audit_logs (
          id, merchant_id, entity_type, entity_id, action, actor_id, actor_type,
          new_state_json, rule_ids_checked, guardrail_status, ip_address, created_at
        ) VALUES (?, ?, 'disputes', ?, 'SIMULATOR_WEBHOOK_PROCESSED', 'ACT-04', 'SYSTEM', ?, ?, 'PASSED', '127.0.0.1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        `aud_sim_${Date.now()}`,
        merchantId,
        finalDisputeId,
        JSON.stringify({ status: decision.nextStatus, track: decision.track, action: decision.action }),
        JSON.stringify([decision.ruleId, 'BR-016'])
      );

      return {
        dispute_id: finalDisputeId,
        paypal_dispute_id: disputeId,
        status: decision.nextStatus,
        track: decision.track,
        action: decision.action,
        rule_id: decision.ruleId,
        win_probability: winResult.winProbability,
        ev_compete_cents: evResult.evCompeteCents,
      };
    });

    return NextResponse.json({
      success: true,
      persona,
      transmission_id: transmissionId,
      result,
      webhook_payload: webhookPayload,
    });
  } catch (err: any) {
    console.error('Simulator Webhook Trigger Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
