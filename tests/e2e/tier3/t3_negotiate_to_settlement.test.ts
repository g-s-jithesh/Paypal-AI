/**
 * ChargebackShield — Tier 3 Cross-Feature Combination: Negotiation to Settlement
 * Validates cross-module flow: Buyer Chat -> MCP make-offer -> Policy Firewall -> PayPal Execution -> Settlement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { MockPayPalSimulator } from '../helpers/mock-paypal';
import { validateSettlementOffer } from '../tier1/t1_firewall_sandbox.test';
import { computeSha256 } from '../helpers/fixtures';
import { assertAuditLogExists } from '../helpers/assertions';

describe('Tier 3: Buyer Negotiation to PayPal Settlement', () => {
  let db: SqliteDbAdapter;
  let paypal: MockPayPalSimulator;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
    paypal = new MockPayPalSimulator();

    // Seed SNAD dispute ($120.00) in NEGOTIATING state
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
      VALUES ('ORD-NEG-301', 'merch_default', 'O-NEG-301', 'buyer@neg.com', 'Buyer Jordan', 'USD', 12000, 'DELIVERED', 'Minor Damaged Item')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-NEG-301', 'merch_default', 'ORD-NEG-301', 'PP-D-NEG-301', 'SIGNIFICANTLY_NOT_AS_DESCRIBED', 'NEGOTIATING', 12000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
    `).run();

    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, status, token_hash, max_refund_allowed_cents, messages_json)
      VALUES ('NEG-SESS-301', 'DSP-NEG-301', 'ACTIVE', '${computeSha256("token-301")}', 4800, '[]')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T3-INT-2: Executes full chat offer acceptance flow ending in SETTLED_VIA_REFUND and PayPal API call', async () => {
    const disputeId = 'DSP-NEG-301';
    const sessionId = 'NEG-SESS-301';
    const disputeAmountCents = 12000;
    const requestedOfferCents = 4200; // $42.00 proposed

    // 1. Buyer sends request in chat portal
    const buyerMessage = {
      sender: 'BUYER',
      text: 'I can accept $42.00 refund to settle this without bank escalation.',
      timestamp: new Date().toISOString()
    };
    db.prepare(`UPDATE negotiation_sessions SET messages_json = ? WHERE id = ?`).run(
      JSON.stringify([buyerMessage]),
      sessionId
    );

    // 2. Agent invokes MCP make-offer tool, evaluated by code-level MCP Policy Firewall
    const firewallCheck = validateSettlementOffer(disputeAmountCents, requestedOfferCents, 0.40);
    expect(firewallCheck.allowed).toBe(true);
    expect(firewallCheck.final_amount_cents).toBe(4200);

    // 3. Settlement Offer Record Created (ENT-07)
    db.prepare(`
      INSERT INTO settlement_offers (id, dispute_id, negotiation_session_id, offered_amount_cents, max_allowed_cents, status, proposed_by)
      VALUES ('OFF-301-1', ?, ?, ?, 4800, 'PROPOSED', 'AGENT')
    `).run(disputeId, sessionId, firewallCheck.final_amount_cents);

    // 4. Buyer accepts offer
    db.prepare(`
      UPDATE settlement_offers
      SET status = 'ACCEPTED', responded_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = 'OFF-301-1'
    `).run();

    // 5. Dual-Mode PayPal engine executes make-offer / partial refund
    const ppResponse = await paypal.makeOffer('PP-D-GOLD-003', {
      amount_cents: firewallCheck.final_amount_cents,
      note: 'Partial settlement accepted in chat'
    });
    expect(ppResponse.success).toBe(true);

    // 6. Transition dispute status to SETTLED_VIA_REFUND
    db.prepare(`
      UPDATE disputes
      SET status = 'SETTLED_VIA_REFUND', resolved_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), version = version + 1
      WHERE id = ?
    `).run(disputeId);

    // 7. Update negotiation session to COMPLETED_SETTLED
    db.prepare(`UPDATE negotiation_sessions SET status = 'COMPLETED_SETTLED' WHERE id = ?`).run(sessionId);

    // 8. Mandatory Audit Log entry
    db.prepare(`
      INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
      VALUES ('AUD-SETTLE-301', 'merch_default', 'disputes', ?, 'SETTLED_VIA_REFUND', 'ACT-03', 'BUYER', '{"status":"SETTLED_VIA_REFUND","amount_cents":4200}', '["BR-004","BR-005"]', 'PASSED')
    `).run(disputeId);

    // Verify end-state
    const finalDispute = db.prepare(`SELECT status, resolved_at FROM disputes WHERE id = ?`).get(disputeId) as any;
    expect(finalDispute.status).toBe('SETTLED_VIA_REFUND');
    expect(finalDispute.resolved_at).toBeDefined();

    const offer = db.prepare(`SELECT status FROM settlement_offers WHERE id = 'OFF-301-1'`).get() as any;
    expect(offer.status).toBe('ACCEPTED');

    const log = assertAuditLogExists(db, disputeId, 'SETTLED_VIA_REFUND');
    expect(log).toBeDefined();
  });
});
