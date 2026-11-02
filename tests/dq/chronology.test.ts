import { describe, it, expect } from 'vitest';
import { getSeededDb, createTestDb } from '../helpers/db-helper';

describe('Data Quality: Chronology & Temporal Consistency', () => {
  it('TC-DQ-TIME-001: Dispute SLA Due Date Chronology (BR-002)', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_mode, chargeback_fee_cents, currency)
      VALUES ('m1', 'Test Merchant', 'SIMULATOR', 1500, 'USD')
    `).run();

    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    // seller_response_due_at <= created_at must throw CHECK constraint failed
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
          dispute_amount_cents, created_at, seller_response_due_at
        ) VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-10T10:00:00Z', '2026-11-09T10:00:00Z')
      `).run();
    }).toThrow(/CHECK constraint failed/);

    // seller_response_due_at > created_at succeeds
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
          dispute_amount_cents, created_at, seller_response_due_at
        ) VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-10T10:00:00Z', '2026-11-20T10:00:00Z')
      `).run();
    }).not.toThrow();
  });

  it('TC-DQ-TIME-002: Fulfillment Event Chronology in Golden Dataset', () => {
    const db = getSeededDb();
    const invalidOrders = (
      db
        .prepare(`
          SELECT count(*) as count FROM orders 
          WHERE delivered_at IS NOT NULL AND (delivered_at < shipped_at OR shipped_at < created_at)
        `)
        .get() as { count: number }
    ).count;

    expect(invalidOrders).toBe(0);
  });

  it('TC-DQ-TIME-003: Submission and Resolution Chronology in Golden Dataset', () => {
    const db = getSeededDb();
    const invalidSubmissions = (
      db
        .prepare(`
          SELECT count(*) as count FROM disputes 
          WHERE submitted_at IS NOT NULL AND submitted_at < created_at
        `)
        .get() as { count: number }
    ).count;
    expect(invalidSubmissions).toBe(0);

    const invalidResolutions = (
      db
        .prepare(`
          SELECT count(*) as count FROM disputes 
          WHERE resolved_at IS NOT NULL AND resolved_at < created_at
        `)
        .get() as { count: number }
    ).count;
    expect(invalidResolutions).toBe(0);
  });

  it('TC-DQ-TIME-004: ISO-8601 UTC Format Conformance', () => {
    const db = getSeededDb();
    const disputes = db
      .prepare('SELECT created_at, updated_at, seller_response_due_at FROM disputes LIMIT 20')
      .all() as Array<{
      created_at: string;
      updated_at: string;
      seller_response_due_at: string;
    }>;

    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    for (const d of disputes) {
      expect(d.created_at).toMatch(isoRegex);
      expect(d.updated_at).toMatch(isoRegex);
      expect(d.seller_response_due_at).toMatch(isoRegex);
    }
  });
});
