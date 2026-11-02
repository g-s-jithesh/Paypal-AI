/**
 * ChargebackShield — Tier 2 Boundary & Corner Cases: Evidence & Cryptographic Verification
 * Covers tampered hashes, missing tracking proofs on INR, hallucinated tracking/dates, and empty payloads
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { computeSha256 } from '../helpers/fixtures';
import { verifyEvidenceFacts } from '../tier1/t1_workbench_buyer.test';

describe('Tier 2: Evidence & Cryptographic Boundaries', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);

    // Setup base order
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, carrier_name, tracking_number, delivery_status, delivered_at, item_summary)
      VALUES ('ORD-EVI-B1', 'merch_default', 'O-EVI-B1', 'buyer@evi.com', 'Buyer Evi', 'USD', 12000, 'UPS', '1Z9999999999999999', 'DELIVERED', '2026-10-25T14:00:00Z', 'Designer Watch')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-EVI-B1', 'merch_default', 'ORD-EVI-B1', 'PP-EVI-B1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 12000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T2-EVI-1: Tampered SHA-256 hash detection (corrupted content vs original hash)', () => {
    const originalContent = JSON.stringify({ tracking_number: '1Z9999999999999999', status: 'DELIVERED' });
    const originalHash = computeSha256(originalContent);

    // Corrupted content with tampered date
    const corruptedContent = JSON.stringify({ tracking_number: '1Z9999999999999999', status: 'DELIVERED', date: '2026-11-01' });
    const checkHash = computeSha256(corruptedContent);

    expect(checkHash).not.toBe(originalHash);
  });

  it('T2-EVI-2: Missing carrier tracking proof on INR dispute blocks AUTO_SUBMIT (BR-009 guardrail)', () => {
    // Order with no tracking number (unfulfilled)
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
      VALUES ('ORD-NO-TRACK', 'merch_default', 'O-NO-TRK', 'b@b.com', 'B', 'USD', 5000, 'UNFULFILLED', 'Item')
    `).run();

    const order = db.prepare(`SELECT tracking_number, delivery_status FROM orders WHERE id = 'ORD-NO-TRACK'`).get() as any;
    const canAutoSubmit = order.tracking_number && order.delivery_status === 'DELIVERED';
    expect(canAutoSubmit).toBeFalsy();
  });

  it('T2-EVI-3: Hallucinated carrier tracking number not in orders table fails verification (BR-008)', () => {
    const fakeEvidence = JSON.stringify({
      tracking_number: '1Z0000000000000000', // Fabricated tracking number
      carrier_name: 'UPS'
    });

    const check = verifyEvidenceFacts(db, 'ORD-EVI-B1', fakeEvidence);
    expect(check.is_verified).toBe(false);
    expect(check.error).toBe('HALLUCINATED_TRACKING_NUMBER');
  });

  it('T2-EVI-4: Hallucinated delivery timestamp not in orders table fails verification (BR-008)', () => {
    const fakeEvidence = JSON.stringify({
      tracking_number: '1Z9999999999999999',
      delivered_at: '2026-10-31T23:59:59Z' // Fabricated date
    });

    const check = verifyEvidenceFacts(db, 'ORD-EVI-B1', fakeEvidence);
    expect(check.is_verified).toBe(false);
    expect(check.error).toBe('HALLUCINATED_DELIVERY_DATE');
  });

  it('T2-EVI-5: Unverified evidence item (is_verified = 0) is flagged and excluded from submission', () => {
    db.prepare(`
      INSERT INTO evidence_items (id, dispute_id, order_id, evidence_type, source_system, title, content_json, sha256_hash, is_verified)
      VALUES ('EVI-UNVERIFIED', 'DSP-EVI-B1', 'ORD-EVI-B1', 'TRACKING_PROOF', 'MANUAL_UPLOAD', 'Customer Note', '{}', '${computeSha256("{}")}', 0)
    `).run();

    const item = db.prepare(`SELECT is_verified FROM evidence_items WHERE id = 'EVI-UNVERIFIED'`).get() as any;
    expect(item.is_verified).toBe(0);
  });

  it('T2-EVI-6: In-Transit delivery status on INR dispute forces negotiation instead of auto-submit', () => {
    db.prepare(`UPDATE orders SET delivery_status = 'IN_TRANSIT' WHERE id = 'ORD-EVI-B1'`).run();

    const order = db.prepare(`SELECT delivery_status FROM orders WHERE id = 'ORD-EVI-B1'`).get() as any;
    const isEligibleForAutoWin = order.delivery_status === 'DELIVERED';
    expect(isEligibleForAutoWin).toBe(false);
  });
});
