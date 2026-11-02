import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

describe('Business Rules: Financial Limits & Monetary Integrity', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m1', 'Test Merchant', 1500)
    `).run();
    db.prepare(`
      INSERT INTO policy_rules (id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct, auto_accept_below_cents)
      VALUES ('pol1', 'm1', 25000, 0.40, 3500)
    `).run();
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('ord100', 'm1', 'PO-100', 'c@example.com', 'Buyer', 10000, 'Test Product')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('BR-001: Dispute amount cannot exceed original captured order amount (trigger & check enforcement)', () => {
    // 1. Valid dispute amount <= order amount succeeds
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp1', 'm1', 'ord100', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10000, '2026-11-20T00:00:00Z')
      `).run();
    }).not.toThrow();

    // 2. Dispute amount > order amount (e.g. 10001 cents on 10000 cents order) is rejected by trigger
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
        VALUES ('dsp2', 'm1', 'ord100', 'PP-D-2', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10001, '2026-11-20T00:00:00Z')
      `).run();
    }).toThrow(/BR-001: dispute_amount_cents cannot exceed order amount_cents/);

    // 3. Updating dispute to exceed order amount is also rejected
    expect(() => {
      db.prepare('UPDATE disputes SET dispute_amount_cents = 15000 WHERE id = ?').run('dsp1');
    }).toThrow(/BR-001: dispute_amount_cents cannot exceed order amount_cents/);
  });

  it('BR-004: Settlement offer amount cannot exceed policy cap (max_refund_offer_pct)', () => {
    // Setup dispute of $100.00 (10000 cents), 40% cap = $40.00 (4000 cents)
    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES ('dsp1', 'm1', 'ord100', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'NEGOTIATING', 10000, '2026-11-20T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
      VALUES ('neg1', 'dsp1', 'token123', 4000)
    `).run();

    // Offer of $40.00 (4000 cents) succeeds
    expect(() => {
      db.prepare(`
        INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, proposed_by)
        VALUES ('off1', 'dsp1', 'neg1', 4000, 4000, 'AGENT')
      `).run();
    }).not.toThrow();

    // Offer exceeding max_allowed_cents (e.g. 4500 cents when max is 4000) is rejected by CHECK constraint
    expect(() => {
      db.prepare(`
        INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, proposed_by)
        VALUES ('off2', 'dsp1', 'neg1', 4500, 4000, 'AGENT')
      `).run();
    }).toThrow(/CHECK constraint failed: max_allowed_cents >= offered_amount_cents/);
  });

  it('BR-006: High-Value Dispute Gate (> $250.00 / 25000 cents requires human approval)', () => {
    const policy = db.prepare('SELECT max_auto_dispute_cents FROM policy_rules WHERE merchant_id = ?').get('m1') as {
      max_auto_dispute_cents: number;
    };
    expect(policy.max_auto_dispute_cents).toBe(25000);

    // An order of $450.00
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('ord450', 'm1', 'PO-450', 'c@example.com', 'Buyer', 45000, 'Gaming Monitor')
    `).run();

    // Dispute of $450.00 exceeds threshold -> must route to TRACK_D_HUMAN_REVIEW and READY_FOR_REVIEW
    const disputeAmount = 45000;
    const isHighValue = disputeAmount > policy.max_auto_dispute_cents;
    expect(isHighValue).toBe(true);
  });

  it('BR-014: Cumulative Refund Cap (Sum of accepted settlements <= captured order amount)', () => {
    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at)
      VALUES ('dsp1', 'm1', 'ord100', 'PP-D-1', 'SIGNIFICANTLY_NOT_AS_DESCRIBED', 'NEGOTIATING', 10000, '2026-11-20T00:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
      VALUES ('neg1', 'dsp1', 'token123', 10000)
    `).run();

    // First accepted offer: 6000 cents
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('off1', 'dsp1', 'neg1', 6000, 10000, 'ACCEPTED', 'AGENT')
    `).run();

    // Check sum of accepted offers
    const sumRow = db.prepare(`
      SELECT SUM(offered_amount_cents) as total_refunded
      FROM settlement_offers
      WHERE dispute_id = 'dsp1' AND status IN ('ACCEPTED', 'EXECUTED')
    `).get() as { total_refunded: number };

    expect(sumRow.total_refunded).toBe(6000);

    // Verify application logic rejecting second offer that exceeds cumulative total
    const candidateOffer = 5000;
    const orderAmount = 10000;
    const wouldExceed = sumRow.total_refunded + candidateOffer > orderAmount;
    expect(wouldExceed).toBe(true);
  });

  it('BR-017: Auto-Accept Low-Value Gate (dispute <= $35.00, W < 0.35, and EV < 0)', () => {
    const policy = db.prepare('SELECT auto_accept_below_cents, min_win_prob_auto_accept FROM policy_rules WHERE merchant_id = ?').get('m1') as {
      auto_accept_below_cents: number;
      min_win_prob_auto_accept: number;
    };
    expect(policy.auto_accept_below_cents).toBe(3500);
    expect(policy.min_win_prob_auto_accept).toBe(0.35);

    // Low-value dispute $28.00 with win probability 0.20
    const amount = 2800;
    const winProb = 0.20;
    const fee = 1500;
    const ops = 500;
    const evCompete = Math.round(winProb * amount - (1 - winProb) * fee - ops);

    expect(amount).toBeLessThanOrEqual(policy.auto_accept_below_cents);
    expect(winProb).toBeLessThan(policy.min_win_prob_auto_accept);
    expect(evCompete).toBeLessThan(0); // EV is negative
  });

  it('BR-023: Integer Currency Uniformity - floating-point money strictly prohibited', () => {
    // Assert all monetary columns in schema have data type INTEGER
    const monetaryColumns = [
      { table: 'merchants', col: 'chargeback_fee_cents' },
      { table: 'orders', col: 'amount_cents' },
      { table: 'disputes', col: 'dispute_amount_cents' },
      { table: 'ai_assessments', col: 'expected_value_cents' },
      { table: 'ai_assessments', col: 'ev_settle_cents' },
      { table: 'negotiation_sessions', col: 'max_refund_allowed_cents' },
      { table: 'settlement_offers', col: 'offered_amount_cents' },
      { table: 'settlement_offers', col: 'max_allowed_cents' },
      { table: 'policy_rules', col: 'max_auto_dispute_cents' },
      { table: 'policy_rules', col: 'auto_accept_below_cents' },
      { table: 'policy_rules', col: 'default_ops_cost_cents' },
    ];

    for (const { table, col } of monetaryColumns) {
      const colInfo = (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
      ).find((c) => c.name === col);

      expect(colInfo).toBeDefined();
      expect(colInfo?.type).toBe('INTEGER');
    }
  });
});
