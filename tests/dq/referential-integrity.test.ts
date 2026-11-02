import { describe, it, expect } from 'vitest';
import { getSeededDb, createTestDb } from '../helpers/db-helper';

describe('Data Quality: Referential Integrity & Orphan Prevention', () => {
  it('TC-DQ-FK-001: PRAGMA foreign_key_check on Golden Dataset reports 0 violations', () => {
    const db = getSeededDb();
    const violations = db.prepare('PRAGMA foreign_key_check').all() as any[];
    expect(violations.length).toBe(0);
  });

  it('TC-DQ-FK-002: Explicit SQL Orphan Scans across all FK vectors return strictly 0', () => {
    const db = getSeededDb();

    // 1. orders -> merchants
    const orphanOrders = (
      db.prepare('SELECT count(*) as count FROM orders WHERE merchant_id NOT IN (SELECT id FROM merchants)').get() as { count: number }
    ).count;
    expect(orphanOrders).toBe(0);

    // 2. disputes -> merchants
    const orphanDisputesMerch = (
      db.prepare('SELECT count(*) as count FROM disputes WHERE merchant_id NOT IN (SELECT id FROM merchants)').get() as { count: number }
    ).count;
    expect(orphanDisputesMerch).toBe(0);

    // 3. disputes -> orders
    const orphanDisputesOrder = (
      db.prepare('SELECT count(*) as count FROM disputes WHERE order_id NOT IN (SELECT id FROM orders)').get() as { count: number }
    ).count;
    expect(orphanDisputesOrder).toBe(0);

    // 4. evidence_items -> disputes
    const orphanEvidenceDispute = (
      db.prepare('SELECT count(*) as count FROM evidence_items WHERE dispute_id NOT IN (SELECT id FROM disputes)').get() as { count: number }
    ).count;
    expect(orphanEvidenceDispute).toBe(0);

    // 5. evidence_items -> orders
    const orphanEvidenceOrder = (
      db.prepare('SELECT count(*) as count FROM evidence_items WHERE order_id NOT IN (SELECT id FROM orders)').get() as { count: number }
    ).count;
    expect(orphanEvidenceOrder).toBe(0);

    // 6. ai_assessments -> disputes
    const orphanAssessments = (
      db.prepare('SELECT count(*) as count FROM ai_assessments WHERE dispute_id NOT IN (SELECT id FROM disputes)').get() as { count: number }
    ).count;
    expect(orphanAssessments).toBe(0);

    // 7. negotiation_sessions -> disputes
    const orphanSessions = (
      db.prepare('SELECT count(*) as count FROM negotiation_sessions WHERE dispute_id NOT IN (SELECT id FROM disputes)').get() as { count: number }
    ).count;
    expect(orphanSessions).toBe(0);

    // 8. settlement_offers -> disputes
    const orphanOffersDispute = (
      db.prepare('SELECT count(*) as count FROM settlement_offers WHERE dispute_id NOT IN (SELECT id FROM disputes)').get() as { count: number }
    ).count;
    expect(orphanOffersDispute).toBe(0);

    // 9. settlement_offers -> negotiation_sessions
    const orphanOffersSession = (
      db.prepare('SELECT count(*) as count FROM settlement_offers WHERE negotiation_session_id NOT IN (SELECT id FROM negotiation_sessions)').get() as { count: number }
    ).count;
    expect(orphanOffersSession).toBe(0);

    // 10. policy_rules -> merchants
    const orphanPolicies = (
      db.prepare('SELECT count(*) as count FROM policy_rules WHERE merchant_id NOT IN (SELECT id FROM merchants)').get() as { count: number }
    ).count;
    expect(orphanPolicies).toBe(0);
  });

  it('TC-DQ-FK-003: Rejection of Orphaned Inserts', () => {
    const db = createTestDb();

    // Inserting a dispute with non-existent order_id fails
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('d_orphan', 'm_nonexistent', 'o_nonexistent', 'PP-D-ORPHAN', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
      `).run();
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('TC-DQ-FK-004: RESTRICT enforcement on parent deletion', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_mode, chargeback_fee_cents, currency)
      VALUES ('m1', 'Test Merchant', 'SIMULATOR', 1500, 'USD')
    `).run();

    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('o1', 'm1', 'PO-1', 'b@test.com', 'Buyer', 5000, 'Item')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES ('d1', 'm1', 'o1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, '2026-11-20T00:00:00Z')
    `).run();

    // Deleting order when dispute references it with RESTRICT should fail
    expect(() => {
      db.prepare('DELETE FROM orders WHERE id = ?').run('o1');
    }).toThrow(/FOREIGN KEY constraint failed/);
  });
});
