/**
 * ChargebackShield — Dispute Queue API Endpoint
 * Provides filtered, sorted dispute records with SLA calculations (BR-010, M4)
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const statusFilter = searchParams.get('status') || 'ALL';
    const reasonFilter = searchParams.get('reason') || 'ALL';
    const search = searchParams.get('search') || '';
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 100);
    const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

    const db = getDb();

    // Base query conditions
    const conditions: string[] = [];
    const params: any[] = [];

    if (statusFilter !== 'ALL') {
      conditions.push('d.status = ?');
      params.push(statusFilter);
    }

    if (reasonFilter !== 'ALL') {
      conditions.push('d.reason_code = ?');
      params.push(reasonFilter);
    }

    if (search.trim()) {
      conditions.push('(d.id LIKE ? OR d.paypal_dispute_id LIKE ? OR d.order_id LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ?)');
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count matching current filter
    const countRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      ${whereClause}
    `).get(...params) as { total: number };

    // Fetch dispute rows sorted by seller_response_due_at ascending (nearest deadline first)
    const query = `
      SELECT
        d.id,
        d.merchant_id,
        d.order_id,
        d.paypal_dispute_id,
        d.reason_code,
        d.status,
        d.dispute_amount_cents,
        d.currency,
        d.seller_response_due_at,
        d.stage,
        d.track,
        d.version,
        d.submitted_at,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        o.customer_name,
        o.customer_email,
        o.carrier_name,
        o.tracking_number,
        o.delivery_status,
        o.delivered_at,
        o.delivery_signature_name,
        o.item_summary,
        o.amount_cents as order_amount_cents,
        (SELECT win_probability FROM ai_assessments WHERE dispute_id = d.id ORDER BY created_at DESC LIMIT 1) as win_probability,
        (SELECT recommended_action FROM ai_assessments WHERE dispute_id = d.id ORDER BY created_at DESC LIMIT 1) as recommended_action,
        (SELECT COUNT(*) FROM evidence_items WHERE dispute_id = d.id) as evidence_count,
        (SELECT COUNT(*) FROM evidence_items WHERE dispute_id = d.id AND is_verified = 1) as verified_evidence_count
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      ${whereClause}
      ORDER BY d.seller_response_due_at ASC
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(query).all(...params, limit, offset) as any[];

    const now = Date.now();
    const disputes = rows.map((r) => {
      const dueTime = new Date(r.seller_response_due_at).getTime();
      const diffMs = dueTime - now;
      const hoursRemaining = Math.max(0, Math.round((diffMs / (1000 * 3600)) * 10) / 10);
      const isExpired = diffMs <= 0 && !['WON', 'LOST', 'SETTLED_VIA_REFUND'].includes(r.status);
      const isCritical = diffMs <= 4 * 3600 * 1000 && !['WON', 'LOST', 'SETTLED_VIA_REFUND'].includes(r.status);
      const isWarning = diffMs <= 24 * 3600 * 1000 && !isCritical && !['WON', 'LOST', 'SETTLED_VIA_REFUND'].includes(r.status);

      return {
        ...r,
        hours_remaining: hoursRemaining,
        sla_urgency: isExpired ? 'EXPIRED' : isCritical ? 'CRITICAL' : isWarning ? 'WARNING' : 'NORMAL',
        is_high_value: r.dispute_amount_cents > 25000,
      };
    });

    // Compute status counts for filter badges
    const statusCountsRaw = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM disputes
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const statusCounts: Record<string, number> = { ALL: 0 };
    for (const sc of statusCountsRaw) {
      statusCounts[sc.status] = sc.count;
      statusCounts.ALL += sc.count;
    }

    return NextResponse.json({
      success: true,
      total: countRow.total,
      limit,
      offset,
      statusCounts,
      disputes,
    });
  } catch (err: any) {
    console.error('Disputes Queue API Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
