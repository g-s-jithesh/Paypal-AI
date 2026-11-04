/**
 * ChargebackShield — One-Click Analyst Approval Endpoint (BR-006)
 * Authorizes high-value disputes (> $250.00) or review-queued disputes for submission to PayPal
 */

import { NextResponse } from 'next/server';
import { getDb, runTransaction } from '@/lib/db';
import { getPayPalClient } from '@/lib/paypal';
import { recordFirewallAuditLog } from '@/lib/firewall/audit-logger';
import { TERMINAL_STATUSES } from '@/lib/engine/decision-router';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'APPROVE'; // 'APPROVE' or 'REJECT_TO_NEGOTIATE'
    const notes = body.notes || 'Analyst 1-click sign-off via Workbench (BR-006)';

    const db = getDb();
    const paypalClient = getPayPalClient();

    // 1. Fetch Dispute
    const dispute = db.prepare(`
      SELECT d.*, o.carrier_name, o.tracking_number
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE d.id = ? OR d.paypal_dispute_id = ?
    `).get(id, id) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute ${id} not found` }, { status: 404 });
    }

    if (TERMINAL_STATUSES.includes(dispute.status)) {
      return NextResponse.json({
        error: `Dispute ${dispute.id} is in terminal status ${dispute.status} (BR-005)`,
      }, { status: 409 });
    }

    if (action === 'APPROVE') {
      // 1. Submit evidence to PayPal
      const paypalRes = await paypalClient.provideEvidence(dispute.paypal_dispute_id || dispute.id, {
        evidence_type: 'PROOF_OF_DELIVERY',
        notes,
        tracking_number: dispute.tracking_number,
        carrier: dispute.carrier_name,
      });

      // 2. Atomically transition dispute status to SUBMITTED & record audit log (actor_id = ACT-01)
      runTransaction((conn) => {
        conn.prepare(`
          UPDATE disputes
          SET status = 'SUBMITTED',
              track = 'TRACK_D_HUMAN_REVIEW',
              submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              version = version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(dispute.id);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'disputes',
          entityId: dispute.id,
          action: 'MANUAL_APPROVAL',
          actorId: 'ACT-01',
          actorType: 'MERCHANT_USER',
          previousStateJson: { status: dispute.status },
          newStateJson: {
            status: 'SUBMITTED',
            notes,
            paypal_reference_id: paypalRes.paypal_reference_id,
          },
          ruleIdsChecked: ['BR-006'],
          guardrailStatus: 'PASSED',
        }, conn);
      }, db);

      return NextResponse.json({
        success: true,
        action: 'APPROVED',
        status: 'SUBMITTED',
        dispute_id: dispute.id,
        paypal_reference_id: paypalRes.paypal_reference_id,
        message: 'Dispute successfully approved and evidence submitted to PayPal (BR-006).',
      });
    } else {
      // REJECT_TO_NEGOTIATE
      runTransaction((conn) => {
        conn.prepare(`
          UPDATE disputes
          SET status = 'NEGOTIATING',
              track = 'TRACK_B_NEGOTIATE',
              version = version + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?
        `).run(dispute.id);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'disputes',
          entityId: dispute.id,
          action: 'MANUAL_REJECTION_TO_NEGOTIATE',
          actorId: 'ACT-01',
          actorType: 'MERCHANT_USER',
          previousStateJson: { status: dispute.status },
          newStateJson: { status: 'NEGOTIATING', notes },
          ruleIdsChecked: ['BR-006'],
          guardrailStatus: 'PASSED',
        }, conn);
      }, db);

      return NextResponse.json({
        success: true,
        action: 'REVERTED_TO_NEGOTIATE',
        status: 'NEGOTIATING',
        dispute_id: dispute.id,
        message: 'Dispute rerouted to Buyer Negotiation Portal.',
      });
    }
  } catch (err: any) {
    console.error('Analyst Approval Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
