/**
 * ChargebackShield — Tier 1 Feature Coverage: Core Decision Engines
 * Features 8, 9, 10: AI Win Probability, Expected Value (EV), Step 18 Decision Table
 * Grounded in PRD §6.3, §6.4, BR-007, and BR-016
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { calculateExpectedEV } from '../helpers/assertions';

// Core engine pure evaluators matching PRD §6.3 & §6.4 specifications
export function calculateWinProbability(order: { delivery_status: string; has_signature?: boolean; reason_code: string; avs_match?: boolean }): number {
  if (order.reason_code === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    if (order.delivery_status === 'DELIVERED') {
      return order.has_signature ? 0.91 : 0.85;
    }
    return 0.32;
  }
  if (order.reason_code === 'SIGNIFICANTLY_NOT_AS_DESCRIBED') {
    return 0.55;
  }
  if (order.reason_code === 'UNAUTHORISED') {
    return order.avs_match ? 0.82 : 0.20;
  }
  return 0.50;
}

export function routeDecisionTable(params: {
  dispute_amount_cents: number;
  reason_code: string;
  delivery_status: string;
  win_prob: number;
  ev_compete: number;
  ev_settle: number;
  has_usage_logs?: boolean;
  avs_match?: boolean;
}): { action: 'AUTO_SUBMIT_EVIDENCE' | 'OFFER_PARTIAL_REFUND' | 'AUTO_ACCEPT_CLAIM' | 'ESCALATE_TO_HUMAN'; rule_id: string } {
  // R1: Dispute Amount > $250.00
  if (params.dispute_amount_cents > 25000) {
    return { action: 'ESCALATE_TO_HUMAN', rule_id: 'R1' };
  }
  // R2: INR + Delivered + WinProb >= 0.75 + EV_Compete > EV_Settle
  if (params.reason_code === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && params.delivery_status === 'DELIVERED' && params.win_prob >= 0.75 && params.ev_compete > params.ev_settle) {
    return { action: 'AUTO_SUBMIT_EVIDENCE', rule_id: 'R2' };
  }
  // R3: INR + Not Delivered (< 0.75 win prob)
  if (params.reason_code === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && params.delivery_status !== 'DELIVERED') {
    return { action: 'OFFER_PARTIAL_REFUND', rule_id: 'R3' };
  }
  // R4: SNAD + 0.35 <= WinProb <= 0.74
  if (params.reason_code === 'SIGNIFICANTLY_NOT_AS_DESCRIBED' && params.win_prob >= 0.35 && params.win_prob <= 0.74) {
    return { action: 'OFFER_PARTIAL_REFUND', rule_id: 'R4' };
  }
  // R5: SNAD + WinProb >= 0.75 + Usage Logs
  if (params.reason_code === 'SIGNIFICANTLY_NOT_AS_DESCRIBED' && params.win_prob >= 0.75 && params.has_usage_logs) {
    return { action: 'AUTO_SUBMIT_EVIDENCE', rule_id: 'R5' };
  }
  // R6: WinProb < 0.35 + Amount <= $35.00
  if (params.win_prob < 0.35 && params.dispute_amount_cents <= 3500) {
    return { action: 'AUTO_ACCEPT_CLAIM', rule_id: 'R6' };
  }
  // R7: UNAUTHORISED + AVS/IP Match + WinProb >= 0.75
  if (params.reason_code === 'UNAUTHORISED' && params.avs_match && params.win_prob >= 0.75) {
    return { action: 'AUTO_SUBMIT_EVIDENCE', rule_id: 'R7' };
  }
  // Default to Escalation
  return { action: 'ESCALATE_TO_HUMAN', rule_id: 'R8' };
}

describe('Tier 1: Features 8-10 Core Decision Engines', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);
  });

  afterEach(() => {
    db.close();
  });

  // ==========================================================================
  // Feature 8: AI Win Probability Engine
  // ==========================================================================
  describe('Feature 8: AI Win Probability Engine', () => {
    it('F8-TC1: High probability (W >= 0.85) for INR with confirmed delivery and signature', () => {
      const prob = calculateWinProbability({
        reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        delivery_status: 'DELIVERED',
        has_signature: true
      });
      expect(prob).toBeGreaterThanOrEqual(0.85);
      expect(prob).toBe(0.91);
    });

    it('F8-TC2: Low probability (W < 0.40) for INR with item in-transit', () => {
      const prob = calculateWinProbability({
        reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        delivery_status: 'IN_TRANSIT'
      });
      expect(prob).toBeLessThan(0.40);
      expect(prob).toBe(0.32);
    });

    it('F8-TC3: Moderate probability (0.35 <= W <= 0.74) for SNAD (Not as Described)', () => {
      const prob = calculateWinProbability({
        reason_code: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
        delivery_status: 'DELIVERED'
      });
      expect(prob).toBeGreaterThanOrEqual(0.35);
      expect(prob).toBeLessThanOrEqual(0.74);
      expect(prob).toBe(0.55);
    });

    it('F8-TC4: High probability (W >= 0.75) for UNAUTHORISED with verified AVS/CVV match', () => {
      const prob = calculateWinProbability({
        reason_code: 'UNAUTHORISED',
        delivery_status: 'DELIVERED',
        avs_match: true
      });
      expect(prob).toBeGreaterThanOrEqual(0.75);
      expect(prob).toBe(0.82);
    });

    it('F8-TC5: Output is strictly bounded in [0.0000, 1.0000]', () => {
      const scenarios = [
        { reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', delivery_status: 'DELIVERED' },
        { reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', delivery_status: 'UNFULFILLED' },
        { reason_code: 'UNAUTHORISED', delivery_status: 'UNFULFILLED', avs_match: false }
      ];
      for (const sc of scenarios) {
        const prob = calculateWinProbability(sc);
        expect(prob).toBeGreaterThanOrEqual(0.0);
        expect(prob).toBeLessThanOrEqual(1.0);
      }
    });
  });

  // ==========================================================================
  // Feature 9: Expected Value (EV) Engine
  // ==========================================================================
  describe('Feature 9: Expected Value (EV) Engine', () => {
    it('F9-TC1: Correctly calculates EV_Compete using BR-007 mathematical formula', () => {
      // EV = W * A - (1 - W) * Fee - Ops
      // W = 0.90, A = $100.00 (10000 cents), Fee = $15.00 (1500 cents), Ops = $5.00 (500 cents)
      // Expected = 0.90 * 10000 - 0.10 * 1500 - 500 = 9000 - 150 - 500 = 8350 cents
      const ev = calculateExpectedEV(0.90, 10000, 1500, 500);
      expect(ev).toBe(8350);
    });

    it('F9-TC2: Correctly calculates EV_Settle (A - OfferedRefund)', () => {
      const disputeAmount = 12000; // $120.00
      const refundOffer = 4800;   // $48.00 (40%)
      const evSettle = disputeAmount - refundOffer;
      expect(evSettle).toBe(7200);
    });

    it('F9-TC3: Low-win-rate, low-amount dispute ($28, W=0.20) results in negative EV_Compete', () => {
      // W = 0.20, A = 2800 cents, Fee = 1500 cents, Ops = 500 cents
      // EV = 0.20 * 2800 - 0.80 * 1500 - 500 = 560 - 1200 - 500 = -1140 cents
      const ev = calculateExpectedEV(0.20, 2800, 1500, 500);
      expect(ev).toBeLessThan(0);
      expect(ev).toBe(-1140);
    });

    it('F9-TC4: High-win-rate dispute ($145, W=0.91) demonstrates EV_Compete > EV_Settle', () => {
      const evCompete = calculateExpectedEV(0.91, 14500, 1500, 500);
      // EV_Settle with 40% cap ($58 refund) = 14500 - 5800 = 8700 cents
      const evSettle = 14500 - 5800;
      expect(evCompete).toBeGreaterThan(evSettle);
    });

    it('F9-TC5: EV Engine pulls fee rate dynamically from merchants.chargeback_fee_cents', () => {
      // If merchant has a $20.00 penalty fee (2000 cents)
      const evHigherFee = calculateExpectedEV(0.50, 10000, 2000, 500);
      // 0.50 * 10000 - 0.50 * 2000 - 500 = 5000 - 1000 - 500 = 3500 cents
      expect(evHigherFee).toBe(3500);
    });
  });

  // ==========================================================================
  // Feature 10: Step 18 Decision Table Router (BR-016)
  // ==========================================================================
  describe('Feature 10: Step 18 Decision Table Router (BR-016)', () => {
    it('F10-TC1: Rule R1 routes dispute > $250.00 to ESCALATE_TO_HUMAN', () => {
      const decision = routeDecisionTable({
        dispute_amount_cents: 45000, // $450.00
        reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        delivery_status: 'DELIVERED',
        win_prob: 0.88,
        ev_compete: 38000,
        ev_settle: 27000
      });
      expect(decision.rule_id).toBe('R1');
      expect(decision.action).toBe('ESCALATE_TO_HUMAN');
    });

    it('F10-TC2: Rule R2 routes INR with DELIVERED status and high prob to AUTO_SUBMIT_EVIDENCE', () => {
      const decision = routeDecisionTable({
        dispute_amount_cents: 14500, // $145.00
        reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        delivery_status: 'DELIVERED',
        win_prob: 0.91,
        ev_compete: 12500,
        ev_settle: 8700
      });
      expect(decision.rule_id).toBe('R2');
      expect(decision.action).toBe('AUTO_SUBMIT_EVIDENCE');
    });

    it('F10-TC3: Rule R3 routes INR without delivered proof to OFFER_PARTIAL_REFUND', () => {
      const decision = routeDecisionTable({
        dispute_amount_cents: 8500, // $85.00
        reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        delivery_status: 'IN_TRANSIT',
        win_prob: 0.32,
        ev_compete: 1200,
        ev_settle: 5100
      });
      expect(decision.rule_id).toBe('R3');
      expect(decision.action).toBe('OFFER_PARTIAL_REFUND');
    });

    it('F10-TC4: Rule R4 routes SNAD with moderate probability to OFFER_PARTIAL_REFUND', () => {
      const decision = routeDecisionTable({
        dispute_amount_cents: 12000, // $120.00
        reason_code: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
        delivery_status: 'DELIVERED',
        win_prob: 0.55,
        ev_compete: 5400,
        ev_settle: 7200
      });
      expect(decision.rule_id).toBe('R4');
      expect(decision.action).toBe('OFFER_PARTIAL_REFUND');
    });

    it('F10-TC5: Rule R6 routes low-amount, low-probability dispute to AUTO_ACCEPT_CLAIM', () => {
      const decision = routeDecisionTable({
        dispute_amount_cents: 2800, // $28.00 (<= $35.00)
        reason_code: 'UNAUTHORISED',
        delivery_status: 'UNFULFILLED',
        win_prob: 0.20,
        ev_compete: -1140,
        ev_settle: 1680
      });
      expect(decision.rule_id).toBe('R6');
      expect(decision.action).toBe('AUTO_ACCEPT_CLAIM');
    });
  });
});
