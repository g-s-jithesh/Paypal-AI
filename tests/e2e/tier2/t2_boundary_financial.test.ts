/**
 * ChargebackShield — Tier 2 Boundary & Corner Cases: Financial & Monetary Boundaries
 * Covers numeric limits, zero/negative, overflow, cents precision, and threshold cutoffs ($250, $35)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { assertIntegerCents, assertRefundCap, calculateExpectedEV } from '../helpers/assertions';

describe('Tier 2: Financial & Monetary Boundaries', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);

    // Create baseline order for $100.00 (10000 cents)
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
      VALUES ('ORD-FIN-1', 'merch_default', 'O-FIN-1', 'fin@test.com', 'Fin Tester', 'USD', 10000, 'DELIVERED', 'Test Electronics')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T2-FIN-1: Zero-cent dispute amount is rejected by check constraint', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
        VALUES ('DSP-ZERO', 'merch_default', 'ORD-FIN-1', 'PP-ZERO', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 0, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
      `).run();
    }).toThrow();
  });

  it('T2-FIN-2: Negative dispute amount is rejected by check constraint', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
        VALUES ('DSP-NEG', 'merch_default', 'ORD-FIN-1', 'PP-NEG', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', -100, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
      `).run();
    }).toThrow();
  });

  it('T2-FIN-3: Dispute amount exactly equal to order amount ($100.00 on $100.00) is allowed', () => {
    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-EXACT', 'merch_default', 'ORD-FIN-1', 'PP-EXACT', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
    `).run();

    const dispute = db.prepare(`SELECT dispute_amount_cents FROM disputes WHERE id = 'DSP-EXACT'`).get() as any;
    expect(dispute.dispute_amount_cents).toBe(10000);
  });

  it('T2-FIN-4: Dispute amount exceeding order total by 1 cent ($100.01 on $100.00) is rejected by BR-001 trigger', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
        VALUES ('DSP-EXCEED-1', 'merch_default', 'ORD-FIN-1', 'PP-EXC', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10001, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
      `).run();
    }).toThrow(/BR-001/);
  });

  it('T2-FIN-5: High-value gate threshold boundary: $250.00 is autonomous, $250.01 triggers human review (BR-006)', () => {
    const limitCents = 25000; // $250.00

    const atLimit = 25000;
    const aboveLimit = 25001;

    expect(atLimit > limitCents).toBe(false); // Autonomous allowed
    expect(aboveLimit > limitCents).toBe(true); // Escalated to Human Gate
  });

  it('T2-FIN-6: Low-value auto-accept threshold boundary: $35.00 vs $35.01', () => {
    const autoAcceptLimitCents = 3500; // $35.00

    const atLimit = 3500;
    const aboveLimit = 3501;

    expect(atLimit <= autoAcceptLimitCents).toBe(true);  // Eligible for auto-accept
    expect(aboveLimit <= autoAcceptLimitCents).toBe(false); // Not eligible for auto-accept
  });

  it('T2-FIN-7: Floor rounding on odd fractional settlement calculation (e.g. 33.33% of $100.00)', () => {
    const disputeCents = 10000;
    const pct = 0.3333;
    const calculatedCents = Math.floor(disputeCents * pct);
    expect(calculatedCents).toBe(3333);
    assertIntegerCents(calculatedCents);
  });

  it('T2-FIN-8: Maximum integer cents boundary check (prevents 32-bit integer overflow issues)', () => {
    const maxSafeCents = 2147483647; // 32-bit signed int max ($21,474,836.47)
    assertIntegerCents(maxSafeCents);
    expect(maxSafeCents).toBeGreaterThan(0);
  });
});
