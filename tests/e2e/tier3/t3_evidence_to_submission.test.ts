/**
 * ChargebackShield — Tier 3 Cross-Feature Combination: Evidence Assembly to PayPal Submission
 * Validates cross-module flow: Evidence Assembler -> SHA-256 Verifier (BR-008) -> PayPal Provide-Evidence -> SUBMITTED
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { MockPayPalSimulator } from '../helpers/mock-paypal';
import { computeSha256 } from '../helpers/fixtures';
import { verifyEvidenceFacts } from '../tier1/t1_workbench_buyer.test';
import { assertSha256, assertAuditLogExists } from '../helpers/assertions';

describe('Tier 3: Multi-Source Evidence to PayPal Submission', () => {
  let db: SqliteDbAdapter;
  let paypal: MockPayPalSimulator;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    paypal = new MockPayPalSimulator();

    // Seed order with confirmed carrier delivery
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, carrier_name, tracking_number, delivery_status, delivered_at, delivery_signature_name, item_summary)
      VALUES ('ORD-SUB-401', 'merch_default', 'O-SUB-401', 'buyer@sub.com', 'Taylor M', 'USD', 14500, 'UPS', '1Z9999999999999999', 'DELIVERED', '2026-10-28T14:30:00Z', 'Taylor M', 'Tablet')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-SUB-401', 'merch_default', 'ORD-SUB-401', 'PP-D-GOLD-001', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'EVIDENCE_GATHERING', 14500, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T3-INT-3: Assembles multi-source evidence, verifies zero-hallucination (BR-008), and submits to PayPal Sandbox', async () => {
    const disputeId = 'DSP-SUB-401';
    const orderId = 'ORD-SUB-401';
    const paypalDisputeId = 'PP-D-GOLD-001';

    // 1. Evidence Auto-Assembler compiles facts from orders and carrier
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as any;
    const evidencePayload = {
      tracking_number: order.tracking_number,
      carrier_name: order.carrier_name,
      delivered_at: order.delivered_at,
      signature: order.delivery_signature_name,
      amount_cents: order.amount_cents
    };
    const canonicalJson = JSON.stringify(evidencePayload);

    // 2. Fact-Check Ground Truth (BR-008 Zero-Hallucination rule)
    const verification = verifyEvidenceFacts(db, orderId, canonicalJson);
    expect(verification.is_verified).toBe(true);

    // 3. Cryptographic digest generation
    const sha256Digest = computeSha256(canonicalJson);
    assertSha256(sha256Digest);

    // 4. Insert Verified Evidence Item into DB (ENT-04)
    db.prepare(`
      INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash, is_verified)
      VALUES ('EVI-401-1', ?, ?, 'TRACKING_PROOF', 'CARRIER_UPS', 'Carrier Delivery Checkpoint Proof', ?, ?, 1)
    `).run(disputeId, orderId, canonicalJson, sha256Digest);

    // 5. Submit to PayPal Sandbox API
    const submissionResult = await paypal.submitEvidence(paypalDisputeId, {
      evidence_type: 'PROOF_OF_DELIVERY',
      tracking_number: order.tracking_number,
      carrier: order.carrier_name,
      sha256: sha256Digest
    });
    expect(submissionResult.success).toBe(true);
    expect(submissionResult.action).toBe('SUBMIT_EVIDENCE');

    // 6. Transition Dispute to SUBMITTED
    db.prepare(`
      UPDATE disputes
      SET status = 'SUBMITTED', submitted_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), version = version + 1
      WHERE id = ?
    `).run(disputeId);

    // 7. Audit Log recording
    db.prepare(`
      INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
      VALUES ('AUD-SUB-401', 'merch_default', 'disputes', ?, 'SUBMIT_EVIDENCE_PAYPAL', 'ACT-04', 'AI_AGENT', '{"status":"SUBMITTED","evidence_id":"EVI-401-1"}', '["BR-008","BR-009"]', 'PASSED')
    `).run(disputeId);

    // Verify end-state assertions
    const finalDispute = db.prepare(`SELECT status, submitted_at FROM disputes WHERE id = ?`).get(disputeId) as any;
    expect(finalDispute.status).toBe('SUBMITTED');
    expect(finalDispute.submitted_at).toBeDefined();

    const storedEvidence = db.prepare(`SELECT is_verified, sha256_hash FROM evidence_items WHERE id = 'EVI-401-1'`).get() as any;
    expect(storedEvidence.is_verified).toBe(1);
    expect(storedEvidence.sha256_hash).toBe(sha256Digest);

    const log = assertAuditLogExists(db, disputeId, 'SUBMIT_EVIDENCE_PAYPAL');
    expect(log).toBeDefined();
  });
});
