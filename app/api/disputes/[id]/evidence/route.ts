/**
 * ChargebackShield — Evidence Auto-Assembler & Verification API Route
 * Code-level enforcement of BR-008 (SHA-256 Zero-Hallucination Fact Verification)
 */

import { NextResponse } from 'next/server';
import { getDb, runTransaction } from '@/lib/db';
import {
  verifyEvidenceFacts,
  assembleEvidencePackage,
  computeSha256,
} from '@/lib/evidence/verifier';
import { recordFirewallAuditLog } from '@/lib/firewall/audit-logger';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const autoAssemble = body.auto_assemble ?? false;

    const db = getDb();

    // 1. Resolve Dispute & Order
    const dispute = db.prepare(`
      SELECT d.*, o.id as matched_order_id
      FROM disputes d
      LEFT JOIN orders o ON d.order_id = o.id
      WHERE d.id = ? OR d.paypal_dispute_id = ?
    `).get(id, id) as any;

    if (!dispute) {
      return NextResponse.json({ error: `Dispute ${id} not found` }, { status: 404 });
    }

    if (autoAssemble) {
      // 2a. Auto-assemble evidence from ground truth orders table
      const assembled = assembleEvidencePackage(db, dispute.order_id, dispute.id);
      const evidenceId = `evi_auto_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      runTransaction((conn) => {
        conn.prepare(`
          INSERT INTO evidence_items (
            id, dispute_id, order_id, evidence_type, source_system, title,
            content_json, sha256_hash, is_verified, verified_at, created_at
          ) VALUES (?, ?, ?, 'TRACKING_PROOF', 'INTERNAL_CARRIER_SYNC', 'Carrier Proof of Delivery (Auto-Assembled)', ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        `).run(evidenceId, dispute.id, dispute.order_id, assembled.canonical_json, assembled.sha256_hash);

        recordFirewallAuditLog({
          merchantId: dispute.merchant_id,
          entityType: 'disputes',
          entityId: dispute.id,
          action: 'EVIDENCE_AUTO_ASSEMBLED_AND_VERIFIED',
          actorId: 'ACT-01',
          actorType: 'MERCHANT_USER',
          newStateJson: {
            evidence_id: evidenceId,
            sha256_hash: assembled.sha256_hash,
            tracking_number: assembled.tracking_number,
            carrier: assembled.carrier_name,
            is_verified: true,
          },
          ruleIdsChecked: ['BR-008'],
          guardrailStatus: 'PASSED',
        }, conn);
      }, db);

      return NextResponse.json({
        success: true,
        auto_assembled: true,
        is_verified: true,
        evidence_id: evidenceId,
        sha256_hash: assembled.sha256_hash,
        package: assembled,
      });
    }

    // 2b. Manual / external evidence submission: verify facts strictly against ground truth (BR-008)
    const content = body.content || body;
    const verification = verifyEvidenceFacts(db, dispute.order_id, content);

    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const hash = computeSha256(content);
    const evidenceType = body.evidence_type || 'TRACKING_PROOF';
    const title = body.title || 'Supporting Dispute Evidence';
    const sourceSystem = body.source_system || 'MANUAL_ENTRY';

    const evidenceId = `evi_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    runTransaction((conn) => {
      conn.prepare(`
        INSERT INTO evidence_items (
          id, dispute_id, order_id, evidence_type, source_system, title,
          content_json, sha256_hash, is_verified, verified_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        evidenceId,
        dispute.id,
        dispute.order_id,
        evidenceType,
        sourceSystem,
        title,
        contentStr,
        hash,
        verification.is_verified ? 1 : 0,
        verification.is_verified ? new Date().toISOString() : null
      );

      recordFirewallAuditLog({
        merchantId: dispute.merchant_id,
        entityType: 'disputes',
        entityId: dispute.id,
        action: verification.is_verified ? 'EVIDENCE_VERIFIED' : 'EVIDENCE_VERIFICATION_FAILED',
        actorId: 'ACT-01',
        actorType: 'MERCHANT_USER',
        newStateJson: {
          evidence_id: evidenceId,
          sha256_hash: hash,
          is_verified: verification.is_verified,
          error: verification.error,
        },
        ruleIdsChecked: ['BR-008'],
        guardrailStatus: verification.is_verified ? 'PASSED' : 'BLOCKED',
      }, conn);
    }, db);

    return NextResponse.json({
      success: verification.is_verified,
      is_verified: verification.is_verified,
      error: verification.error,
      field: verification.field,
      details: verification.details,
      evidence_id: evidenceId,
      sha256_hash: hash,
    }, { status: verification.is_verified ? 200 : 422 });
  } catch (err: any) {
    console.error('Evidence Verification Error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
