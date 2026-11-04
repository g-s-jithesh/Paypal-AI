/**
 * ChargebackShield — Dispute Detail API Endpoint
 * Returns comprehensive ground truth, fulfillment timeline, evidence, and AI assessment (M4)
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    // 1. Fetch Dispute
    const dispute = db.prepare(`
      SELECT * FROM disputes WHERE id = ? OR paypal_dispute_id = ?
    `).get(id, id) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute not found: ${id}` }, { status: 404 });
    }

    // 2. Fetch Order Ground Truth
    const order = db.prepare(`
      SELECT * FROM orders WHERE id = ?
    `).get(dispute.order_id) as any;

    // 3. Fetch Evidence Items
    const evidenceItems = db.prepare(`
      SELECT * FROM evidence_items
      WHERE dispute_id = ?
      ORDER BY created_at ASC
    `).all(dispute.id) as any[];

    // 4. Fetch AI Assessments
    const assessments = db.prepare(`
      SELECT * FROM ai_assessments
      WHERE dispute_id = ?
      ORDER BY created_at DESC
    `).all(dispute.id) as any[];

    // 5. Fetch Active / Past Negotiation Sessions
    const negotiationSession = db.prepare(`
      SELECT * FROM negotiation_sessions
      WHERE dispute_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(dispute.id) as any;

    // 6. Fetch Settlement Offers
    const settlementOffers = db.prepare(`
      SELECT * FROM settlement_offers
      WHERE dispute_id = ?
      ORDER BY created_at DESC
    `).all(dispute.id) as any[];

    // 7. Fetch Audit Trail
    const auditLogs = db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_id = ? OR entity_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(dispute.id, dispute.order_id) as any[];

    // 8. SLA calculations
    const now = Date.now();
    const dueTime = new Date(dispute.seller_response_due_at).getTime();
    const diffMs = dueTime - now;
    const hoursRemaining = Math.max(0, Math.round((diffMs / (1000 * 3600)) * 10) / 10);
    const isCritical = diffMs <= 4 * 3600 * 1000;
    const isWarning = diffMs <= 24 * 3600 * 1000 && !isCritical;

    // High Value gate (BR-006): > $250.00
    const isHighValue = dispute.dispute_amount_cents > 25000;
    const requiresHumanApproval = isHighValue && ['OPEN', 'READY_FOR_REVIEW', 'EVIDENCE_GATHERING'].includes(dispute.status);

    return NextResponse.json({
      success: true,
      dispute: {
        ...dispute,
        hours_remaining: hoursRemaining,
        sla_urgency: isCritical ? 'CRITICAL' : isWarning ? 'WARNING' : 'NORMAL',
        is_high_value: isHighValue,
        requires_human_approval: requiresHumanApproval,
      },
      order,
      evidenceItems,
      assessment: assessments[0] || null,
      negotiationSession,
      settlementOffers,
      auditLogs,
    });
  } catch (err: any) {
    console.error('Dispute Detail API Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
