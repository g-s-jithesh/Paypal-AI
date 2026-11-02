/**
 * ChargebackShield — Core Decision Engine Test Suite
 * Validates AI Win Probability (BR-003), Expected Value Engine (BR-007, BR-023),
 * Step 18 Decision Matrix (BR-016), and Transactional Persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';
import {
  calculateWinProbability,
  evaluateWinProbabilityFactors,
  clampProbability,
  REASON_BASE_WEIGHTS,
  FEATURE_WEIGHTS,
} from '../../lib/engine/win-probability';
import {
  calculateEvCompete,
  calculateEvSettle,
  calculateEvAccept,
  calculateNetRetainedSettle,
  calculateAllEvs,
} from '../../lib/engine/ev-engine';
import {
  routeStep18,
  persistDecisionResult,
  DecisionResult,
} from '../../lib/engine/decision-router';

describe('Decision Engine: AI Win Probability (BR-003)', () => {
  it('enforces exact reason base weights for INR, SNAD, UNAUTHORISED, RECURRING, and OTHER', () => {
    expect(REASON_BASE_WEIGHTS['MERCHANDISE_OR_SERVICE_NOT_RECEIVED']).toBe(0.50);
    expect(REASON_BASE_WEIGHTS['SIGNIFICANTLY_NOT_AS_DESCRIBED']).toBe(0.35);
    expect(REASON_BASE_WEIGHTS['UNAUTHORISED']).toBe(0.25);
    expect(REASON_BASE_WEIGHTS['CANCELLED_RECURRING_BILLING']).toBe(0.30);
    expect(REASON_BASE_WEIGHTS['OTHER']).toBe(0.25);
  });

  it('enforces exact feature delta weights', () => {
    expect(FEATURE_WEIGHTS.DELIVERY_PROOF).toBe(0.45);
    expect(FEATURE_WEIGHTS.CARRIER_TRACKING).toBe(0.25);
    expect(FEATURE_WEIGHTS.PRIOR_CHARGEBACKS).toBe(-0.30);
    expect(FEATURE_WEIGHTS.ACCOUNT_AGE_GT_1YR).toBe(0.10);
    expect(FEATURE_WEIGHTS.REFUND_POLICY_ACCEPTED).toBe(0.10);
  });

  it('clamps probability strictly to [0.0000, 1.0000] with 4-decimal precision', () => {
    expect(clampProbability(-0.25)).toBe(0.0000);
    expect(clampProbability(1.45)).toBe(1.0000);
    expect(clampProbability(0.74994)).toBe(0.7499);
    expect(clampProbability(0.74996)).toBe(0.7500);
    expect(clampProbability(NaN)).toBe(0.5000);
  });

  it('computes correct factors for INR with delivery proof and carrier tracking', () => {
    const result = evaluateWinProbabilityFactors({
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      deliveryStatus: 'DELIVERED',
      hasSignature: true,
    });
    expect(result.winProbability).toBe(0.9100);
    expect(result.factors.hasDeliveryProof).toBe(true);
    expect(result.factors.hasSignature).toBe(true);
  });

  it('penalizes INR dispute with in-transit status', () => {
    const result = evaluateWinProbabilityFactors({
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      deliveryStatus: 'IN_TRANSIT',
    });
    expect(result.winProbability).toBe(0.3200);
  });

  it('evaluates SNAD dispute with usage logs and delivery proof', () => {
    const result = evaluateWinProbabilityFactors({
      reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      hasUsageLogs: true,
      hasDeliveryProof: true,
    });
    expect(result.winProbability).toBe(0.8200);
  });

  it('evaluates UNAUTHORISED with affirmative AVS/CVV match', () => {
    const withAvs = evaluateWinProbabilityFactors({
      reasonCode: 'UNAUTHORISED',
      hasAvsCvvMatch: true,
      hasDeliveryProof: true,
    });
    expect(withAvs.winProbability).toBe(0.8800);

    const withoutAvs = evaluateWinProbabilityFactors({
      reasonCode: 'UNAUTHORISED',
      hasAvsCvvMatch: false,
    });
    expect(withoutAvs.winProbability).toBe(0.2000);
  });
});

describe('Decision Engine: Expected Value Engine (BR-007, BR-023)', () => {
  it('calculates EV_Compete using integer cents formula: round(W*A - (1-W)*F - C_ops)', () => {
    // W = 0.80, A = $100.00 (10000 cents), F = $15.00 (1500 cents), C_ops = $5.00 (500 cents)
    // 0.80 * 10000 - 0.20 * 1500 - 500 = 8000 - 300 - 500 = 7200 cents ($72.00)
    const ev = calculateEvCompete(0.80, 10000, 1500, 500);
    expect(ev).toBe(7200);

    // Negative EV case: W = 0.20, A = $28.00 (2800 cents)
    // 0.20 * 2800 - 0.80 * 1500 - 500 = 560 - 1200 - 500 = -1140 cents
    const negEv = calculateEvCompete(0.20, 2800, 1500, 500);
    expect(negEv).toBe(-1140);
  });

  it('calculates EV_Settle and EV_Accept correctly', () => {
    expect(calculateEvSettle(4000)).toBe(-4000);
    expect(calculateEvAccept(10000, 1500)).toBe(-11500);
    expect(calculateNetRetainedSettle(10000, 4000)).toBe(6000);
  });

  it('calculates all EVs and recommends appropriate track', () => {
    // High win probability dispute -> COMPETE
    const highEv = calculateAllEvs({
      winProbability: 0.85,
      disputeAmountCents: 14500,
    });
    expect(highEv.evCompeteCents).toBeGreaterThan(0);
    expect(highEv.recommendedTrackByEv).toBe('COMPETE');

    // Very low win probability and low amount -> ACCEPT
    const lowEv = calculateAllEvs({
      winProbability: 0.05,
      disputeAmountCents: 2500,
    });
    expect(lowEv.evCompeteCents).toBeLessThan(0);
  });
});

describe('Decision Engine: Step 18 Decision Matrix (BR-016)', () => {
  it('R1: Escalates disputes > $250.00 to human review (BR-006)', () => {
    const res = routeStep18({
      disputeAmountCents: 45000,
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      winProbability: 0.95,
      deliveryProof: true,
      deliveryStatus: 'DELIVERED',
    });
    expect(res.ruleId).toBe('R1');
    expect(res.action).toBe('ESCALATE_TO_HUMAN');
    expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
    expect(res.nextStatus).toBe('READY_FOR_REVIEW');
  });

  it('R6: Auto-accepts low-value dispute <= $35.00 with W < 0.35 and negative EV (BR-017)', () => {
    const res = routeStep18({
      disputeAmountCents: 2800,
      reasonCode: 'UNAUTHORISED',
      winProbability: 0.20,
      evCompeteCents: -1140,
      deliveryProof: false,
    });
    expect(res.ruleId).toBe('R6');
    expect(res.action).toBe('AUTO_ACCEPT_CLAIM');
    expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
    expect(res.nextStatus).toBe('SETTLED_VIA_REFUND');
  });

  it('R2: INR with verified delivery proof and W >= 0.75 routes to Track A', () => {
    const res = routeStep18({
      disputeAmountCents: 14500,
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      winProbability: 0.91,
      deliveryProof: true,
      deliveryStatus: 'DELIVERED',
    });
    expect(res.ruleId).toBe('R2');
    expect(res.action).toBe('AUTO_SUBMIT_EVIDENCE');
    expect(res.track).toBe('TRACK_A_AUTO_SUBMIT');
    expect(res.nextStatus).toBe('SUBMITTED');
  });

  it('R3: INR without delivery proof routes to Track B negotiation', () => {
    const res = routeStep18({
      disputeAmountCents: 8500,
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      winProbability: 0.32,
      deliveryProof: false,
      deliveryStatus: 'IN_TRANSIT',
    });
    expect(res.ruleId).toBe('R3');
    expect(res.action).toBe('OFFER_PARTIAL_REFUND');
    expect(res.track).toBe('TRACK_B_NEGOTIATE');
    expect(res.nextStatus).toBe('NEGOTIATING');
  });

  it('R5 & R4: SNAD high-confidence vs moderate confidence routing', () => {
    const highSnad = routeStep18({
      disputeAmountCents: 11000,
      reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      winProbability: 0.82,
      hasUsageLogs: true,
      deliveryProof: true,
    });
    expect(highSnad.ruleId).toBe('R5');
    expect(highSnad.action).toBe('AUTO_SUBMIT_EVIDENCE');

    const modSnad = routeStep18({
      disputeAmountCents: 12000,
      reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      winProbability: 0.55,
      deliveryProof: true,
    });
    expect(modSnad.ruleId).toBe('R4');
    expect(modSnad.action).toBe('OFFER_PARTIAL_REFUND');
  });

  it('R7 & R8: UNAUTHORISED with AVS match vs missing AVS', () => {
    const withAvs = routeStep18({
      disputeAmountCents: 18000,
      reasonCode: 'UNAUTHORISED',
      winProbability: 0.85,
      avsCvvMatch: true,
    });
    expect(withAvs.ruleId).toBe('R7');
    expect(withAvs.action).toBe('AUTO_SUBMIT_EVIDENCE');

    const missingAvs = routeStep18({
      disputeAmountCents: 18000,
      reasonCode: 'UNAUTHORISED',
      winProbability: 0.40,
      avsCvvMatch: false,
    });
    expect(missingAvs.ruleId).toBe('R8');
    expect(missingAvs.action).toBe('ESCALATE_TO_HUMAN');
  });
});

describe('Decision Engine: Transactional Persistence (ENT-05, ENT-09, BR-005, BR-015)', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m_test', 'Test Merchant', 1500)
    `).run();

    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, delivery_status, item_summary)
      VALUES ('ord_test', 'm_test', 'PO-TEST', 'buyer@test.com', 'Test Buyer', 14500, 'DELIVERED', 'Test Item')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at, version)
      VALUES ('dsp_test_01', 'm_test', 'ord_test', 'PP-D-TEST-01', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'EVIDENCE_GATHERING', 14500, '2026-11-20T00:00:00Z', 1)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('persists routing decision atomically, increments version, and writes ai_assessments & audit_logs', () => {
    const decision: DecisionResult = {
      action: 'AUTO_SUBMIT_EVIDENCE',
      status: 'SUBMITTED',
      nextStatus: 'SUBMITTED',
      track: 'TRACK_A_AUTO_SUBMIT',
      ruleId: 'R2',
      rule_id: 'R2',
      rationale: 'Confirmed delivery with signature',
      evCompeteCents: 11000,
      evSettleCents: -5800,
      winProbability: 0.91,
    };

    const res = persistDecisionResult(db, {
      disputeId: 'dsp_test_01',
      decision,
    });

    expect(res.assessmentId).toBeDefined();
    expect(res.auditId).toBeDefined();

    // Verify dispute updated
    const updatedDispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get('dsp_test_01') as any;
    expect(updatedDispute.status).toBe('SUBMITTED');
    expect(updatedDispute.track).toBe('TRACK_A_AUTO_SUBMIT');
    expect(updatedDispute.version).toBe(2);
    expect(updatedDispute.submitted_at).toBeDefined();

    // Verify ai_assessments row
    const assessment = db.prepare('SELECT * FROM ai_assessments WHERE id = ?').get(res.assessmentId) as any;
    expect(assessment.win_probability).toBe(0.91);
    expect(assessment.expected_value_cents).toBe(11000);
    expect(assessment.recommended_action).toBe('AUTO_SUBMIT_EVIDENCE');

    // Verify audit_logs row
    const audit = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(res.auditId) as any;
    expect(audit.action).toBe('DISPUTE_ASSESSED_AND_ROUTED');
    expect(audit.guardrail_status).toBe('PASSED');
  });

  it('rejects routing if dispute is in terminal status (BR-005)', () => {
    db.prepare("UPDATE disputes SET status = 'WON' WHERE id = 'dsp_test_01'").run();

    const decision: DecisionResult = {
      action: 'AUTO_SUBMIT_EVIDENCE',
      status: 'SUBMITTED',
      nextStatus: 'SUBMITTED',
      track: 'TRACK_A_AUTO_SUBMIT',
      ruleId: 'R2',
      rule_id: 'R2',
      rationale: 'Test',
      evCompeteCents: 10000,
      evSettleCents: -4000,
      winProbability: 0.85,
    };

    expect(() => {
      persistDecisionResult(db, {
        disputeId: 'dsp_test_01',
        decision,
      });
    }).toThrow(/BR-005: Cannot modify dispute dsp_test_01 in terminal state 'WON'/);
  });

  it('throws concurrency exception on optimistic lock mismatch (BR-015)', () => {
    const decision: DecisionResult = {
      action: 'OFFER_PARTIAL_REFUND',
      status: 'NEGOTIATING',
      nextStatus: 'NEGOTIATING',
      track: 'TRACK_B_NEGOTIATE',
      ruleId: 'R3',
      rule_id: 'R3',
      rationale: 'Test',
      evCompeteCents: 5000,
      evSettleCents: -3000,
      winProbability: 0.50,
    };

    expect(() => {
      persistDecisionResult(db, {
        disputeId: 'dsp_test_01',
        expectedVersion: 999, // Stale version
        decision,
      });
    }).toThrow(/BR-015: Optimistic locking conflict/);
  });
});
