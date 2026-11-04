/**
 * ChargebackShield — Buyer Negotiation Portal Data API
 * Retrieves dispute info, buyer session, message history, and policy caps (M4)
 */

import { NextResponse } from 'next/server';
import { getDb, runTransaction } from '@/lib/db';
import { calculateRefundCap } from '@/lib/firewall/policy-firewall';
import { computeSha256 } from '@/lib/evidence/verifier';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    // 1. Fetch Dispute & Order
    const dispute = db.prepare(`
      SELECT d.*, o.customer_name, o.customer_email, o.item_summary, o.amount_cents as order_amount_cents,
             o.carrier_name, o.tracking_number, o.delivery_status
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE d.id = ? OR d.paypal_dispute_id = ?
    `).get(id, id) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute ${id} not found` }, { status: 404 });
    }

    // 2. Fetch or initialize active negotiation session (BR-019)
    let session = db.prepare(`
      SELECT * FROM negotiation_sessions
      WHERE dispute_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(dispute.id) as any;

    const maxCapCents = calculateRefundCap(dispute.dispute_amount_cents, 0.40);

    if (!session) {
      const sessionId = `neg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const tokenHash = computeSha256(`TOKEN_${dispute.id}`);
      const initialMessages = [
        {
          id: 'msg_welcome',
          sender: 'AGENT',
          text: `Hello ${dispute.customer_name || 'Customer'}. I am the ChargebackShield Resolution Assistant. We understand there is an issue regarding your order (${dispute.item_summary || 'Order ' + dispute.order_id}). Let's work together to resolve this immediately without long bank dispute delays.`,
          timestamp: new Date().toISOString(),
        },
      ];

      runTransaction((conn) => {
        conn.prepare(`
          INSERT INTO negotiation_sessions (
            id, dispute_id, status, token_hash, max_refund_allowed_cents,
            messages_json, guardrail_triggered_count, created_at, updated_at
          ) VALUES (?, ?, 'ACTIVE', ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(sessionId, dispute.id, tokenHash, maxCapCents, JSON.stringify(initialMessages));
      }, db);

      session = db.prepare(`SELECT * FROM negotiation_sessions WHERE id = ?`).get(sessionId) as any;
    }

    // Parse messages safely
    let messages: any[] = [];
    try {
      messages = JSON.parse(session.messages_json || '[]');
    } catch {
      messages = [];
    }

    // 3. Fetch latest settlement offer
    const latestOffer = db.prepare(`
      SELECT * FROM settlement_offers
      WHERE dispute_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(dispute.id) as any;

    return NextResponse.json({
      success: true,
      dispute: {
        id: dispute.id,
        paypal_dispute_id: dispute.paypal_dispute_id,
        status: dispute.status,
        reason_code: dispute.reason_code,
        amount_cents: dispute.dispute_amount_cents,
        currency: dispute.currency,
        customer_name: dispute.customer_name,
        customer_email: dispute.customer_email,
        item_summary: dispute.item_summary,
        delivery_status: dispute.delivery_status,
      },
      session: {
        id: session.id,
        status: session.status,
        max_refund_allowed_cents: session.max_refund_allowed_cents,
        guardrail_triggered_count: session.guardrail_triggered_count,
        messages,
      },
      latestOffer,
    });
  } catch (err: any) {
    console.error('Buyer Portal GET Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
