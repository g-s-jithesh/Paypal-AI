/**
 * ChargebackShield — MCP Policy Firewall Test Suite
 * Validates BR-004, BR-006, BR-014, and BR-017 code-level enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';
import {
  calculateRefundCap,
  normalizeRefundPercentage,
  validateSettlementOffer,
  checkHighValueGate,
  checkNegotiationRounds,
  evaluatePolicyFirewall,
} from '../../lib/firewall/policy-firewall';
import { recordFirewallAuditLog } from '../../lib/firewall/audit-logger';

describe('MCP Policy Firewall: Refund Cap Guardrail (BR-004)', () => {
  it('TC-FW-001: Allows valid settlement offer strictly below policy cap ($40 on $100 dispute with 40% cap)', () => {
    const res = validateSettlementOffer(10000, 4000, 0.40);
    expect(res.allowed).toBe(true);
    expect(res.clamped).toBe(false);
    expect(res.original_amount_cents).toBe(4000);
    expect(res.final_amount_cents).toBe(4000);
    expect(res.guardrail_status).toBe('PASSED');
  });

  it('TC-FW-002: Allows offer at exact boundary cap ($48 on $120 dispute with 40% cap)', () => {
    const res = validateSettlementOffer(12000, 4800, 0.40);
    expect(res.allowed).toBe(true);
    expect(res.clamped).toBe(false);
    expect(res.final_amount_cents).toBe(4800);
    expect(res.guardrail_status).toBe('PASSED');
  });

  it('TC-FW-003: Rejects and clamps offer exceeding policy cap ($60 on $120 dispute)', () => {
    const res = validateSettlementOffer(12000, 6000, 0.40);
    expect(res.allowed).toBe(false);
    expect(res.clamped).toBe(true);
    expect(res.original_amount_cents).toBe(6000);
    expect(res.final_amount_cents).toBe(4800);
    expect(res.max_allowed_cents).toBe(4800);
    expect(res.reason).toBe('EXCEEDS_POLICY_CAP');
    expect(res.guardrail_status).toBe('BLOCKED');
  });

  it('TC-FW-004: Decimal ratio (0.40) and whole percentage (40) yield identical results', () => {
    const cap1 = calculateRefundCap(12000, 0.40);
    const cap2 = calculateRefundCap(12000, 40);
    expect(cap1).toBe(4800);
    expect(cap2).toBe(4800);

    expect(normalizeRefundPercentage(0.40)).toBe(0.40);
    expect(normalizeRefundPercentage(40)).toBe(0.40);
  });

  it('TC-FW-009: Negative and zero offer amounts are rejected with INVALID_AMOUNT', () => {
    const zeroRes = validateSettlementOffer(10000, 0, 0.40);
    expect(zeroRes.allowed).toBe(false);
    expect(zeroRes.reason).toBe('INVALID_AMOUNT');
    expect(zeroRes.guardrail_status).toBe('BLOCKED');

    const negRes = validateSettlementOffer(10000, -500, 0.40);
    expect(negRes.allowed).toBe(false);
    expect(negRes.reason).toBe('INVALID_AMOUNT');
  });
});

describe('MCP Policy Firewall: High-Value Gate (BR-006)', () => {
  it('TC-FW-005: Dispute > $250.00 blocks autonomous action and requires human review', () => {
    const res = checkHighValueGate(45000, 25000);
    expect(res.isHighValue).toBe(true);
    expect(res.requiresHumanReview).toBe(true);
    expect(res.recommendedStatus).toBe('READY_FOR_REVIEW');
  });

  it('TC-FW-006: High-value boundary ($250.00 is allowed; $250.01 triggers gate)', () => {
    const boundaryAllowed = checkHighValueGate(25000, 25000);
    expect(boundaryAllowed.isHighValue).toBe(false);
    expect(boundaryAllowed.requiresHumanReview).toBe(false);

    const boundaryExceeded = checkHighValueGate(25001, 25000);
    expect(boundaryExceeded.isHighValue).toBe(true);
    expect(boundaryExceeded.requiresHumanReview).toBe(true);
  });
});

describe('MCP Policy Firewall: Negotiation Rounds & Cumulative Cap (BR-017, BR-014)', () => {
  it('TC-FW-007: Negotiation rounds check allows rounds 0, 1, 2 and locks on round 3', () => {
    expect(checkNegotiationRounds(0, 3).allowed).toBe(true);
    expect(checkNegotiationRounds(1, 3).allowed).toBe(true);
    expect(checkNegotiationRounds(2, 3).allowed).toBe(true);

    const exhausted = checkNegotiationRounds(3, 3);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.isExhausted).toBe(true);
    expect(exhausted.recommendedStatus).toBe('READY_FOR_REVIEW');
  });

  it('TC-FW-008 & TC-FW-010: Database-backed Policy Evaluation enforces cumulative refund cap and logs audit', () => {
    const db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m_fw', 'Firewall Merchant', 1500)
    `).run();

    db.prepare(`
      INSERT INTO policy_rules (id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct, is_active)
      VALUES ('pol_fw', 'm_fw', 25000, 0.40, 1)
    `).run();

    // Order of $100.00 (10000 cents)
    // Dispute of $100.00
    // Cumulative already refunded: $70.00 (7000 cents)
    // Attempted offer: $35.00 (3500 cents) -> Total $105.00 > $100.00
    const evalRes = evaluatePolicyFirewall({
      merchantId: 'm_fw',
      disputeId: 'dsp_fw_01',
      disputeAmountCents: 10000,
      offeredCents: 3500,
      orderAmountCents: 10000,
      cumulativeRefundedCents: 7000,
      currentRounds: 1,
    }, db);

    expect(evalRes.allowed).toBe(false);
    expect(evalRes.clamped).toBe(true);
    expect(evalRes.final_amount_cents).toBe(3000); // Only 10000 - 7000 = 3000 remaining
    expect(evalRes.reason).toBe('EXCEEDS_CUMULATIVE_ORDER_AMOUNT');
    expect(evalRes.rule_id).toBe('BR-014');

    // Verify audit log row inserted
    const audit = db.prepare('SELECT * FROM audit_logs WHERE merchant_id = ?').get('m_fw') as any;
    expect(audit).toBeDefined();
    expect(audit.guardrail_status).toBe('BLOCKED');
    expect(audit.action).toBe('CUMULATIVE_CAP_EXCEEDED');

    db.close();
  });
});
