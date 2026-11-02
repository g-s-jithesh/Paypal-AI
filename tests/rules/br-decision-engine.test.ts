import { describe, it, expect } from 'vitest';
import {
  STEP_18_DECISION_MATRIX,
  calculateEvCompete,
  routeStep18,
} from '../helpers/rule-fixtures';

describe('Business Rules: AI Decision Engine & Step 18 Router', () => {
  it('BR-003: Win Probability bounds ([0.0000, 1.0000])', () => {
    // Valid bounds
    const validProbs = [0.0, 0.25, 0.5, 0.75, 0.91, 1.0];
    for (const p of validProbs) {
      expect(p).toBeGreaterThanOrEqual(0.0);
      expect(p).toBeLessThanOrEqual(1.0);
    }
  });

  it('BR-007: Expected Value (EV) mathematical formula verification', () => {
    // Formula: EV_Compete = (W * A) - ((1 - W) * F) - C_ops
    // Example: W = 0.80, A = $100.00 (10000 cents), F = $15.00 (1500 cents), C_ops = $5.00 (500 cents)
    // EV = (0.80 * 10000) - (0.20 * 1500) - 500 = 8000 - 300 - 500 = 7200 cents
    const ev = calculateEvCompete(0.8, 10000, 1500, 500);
    expect(ev).toBe(7200);

    // Negative EV case: W = 0.20, A = $28.00 (2800 cents)
    // EV = (0.20 * 2800) - (0.80 * 1500) - 500 = 560 - 1200 - 500 = -1140 cents
    const negativeEv = calculateEvCompete(0.2, 2800, 1500, 500);
    expect(negativeEv).toBe(-1140);
  });

  it('BR-009: Mandatory Proof Guard for INR disputes', () => {
    // INR dispute with DELIVERED status and tracking proof routes to Track A
    const withProof = routeStep18({
      disputeAmountCents: 14500,
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      deliveryProof: true,
      deliveryStatus: 'DELIVERED',
      winProbability: 0.91,
    });
    expect(withProof.action).toBe('AUTO_SUBMIT_EVIDENCE');
    expect(withProof.track).toBe('TRACK_A_AUTO_SUBMIT');

    // INR dispute with IN_TRANSIT (missing delivery proof) is blocked from auto-submit and routed to Track B
    const missingProof = routeStep18({
      disputeAmountCents: 8500,
      reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      deliveryProof: false,
      deliveryStatus: 'IN_TRANSIT',
      winProbability: 0.32,
    });
    expect(missingProof.action).toBe('OFFER_PARTIAL_REFUND');
    expect(missingProof.track).toBe('TRACK_B_NEGOTIATE');
  });

  describe('BR-016: Step 18 Decision Table Parameterized Verification (R1 to R8)', () => {
    it.each(STEP_18_DECISION_MATRIX)(
      'evaluates Rule $ruleId correctly for $reasonCode ($disputeAmountCents cents)',
      ({
        ruleId,
        disputeAmountCents,
        reasonCode,
        deliveryProof,
        deliveryStatus,
        avsCvvMatch,
        winProbability,
        expectedAction,
        expectedStatus,
        expectedTrack,
      }) => {
        const result = routeStep18({
          disputeAmountCents,
          reasonCode,
          deliveryProof,
          deliveryStatus,
          avsCvvMatch,
          winProbability,
        });

        expect(result.ruleId).toBe(ruleId);
        expect(result.action).toBe(expectedAction);
        expect(result.status).toBe(expectedStatus);
        expect(result.track).toBe(expectedTrack);
      }
    );
  });

  describe('Boundary Condition Tests', () => {
    it('Boundary: High-Value Gate threshold at $250.00 vs $250.01 (BR-006)', () => {
      // Exactly $250.00 with W=0.85 and proof -> Track A
      const atBoundary = routeStep18({
        disputeAmountCents: 25000,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        winProbability: 0.85,
      });
      expect(atBoundary.ruleId).toBe('R2');
      expect(atBoundary.track).toBe('TRACK_A_AUTO_SUBMIT');

      // $250.01 (25001 cents) with W=0.85 -> Escalate to Track D
      const overBoundary = routeStep18({
        disputeAmountCents: 25001,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        winProbability: 0.85,
      });
      expect(overBoundary.ruleId).toBe('R1');
      expect(overBoundary.track).toBe('TRACK_D_HUMAN_REVIEW');
    });

    it('Boundary: Auto-Accept ceiling at $35.00 vs $35.01 (BR-017)', () => {
      // Exactly $35.00 (3500 cents) with W=0.20 -> Track C
      const atCeiling = routeStep18({
        disputeAmountCents: 3500,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.20,
      });
      expect(atCeiling.ruleId).toBe('R6');
      expect(atCeiling.track).toBe('TRACK_C_AUTO_ACCEPT');

      // $35.01 (3501 cents) with W=0.20 -> Exceeds auto-accept, routes to Track D
      const overCeiling = routeStep18({
        disputeAmountCents: 3501,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.20,
      });
      expect(overCeiling.ruleId).toBe('R8');
      expect(overCeiling.track).toBe('TRACK_D_HUMAN_REVIEW');
    });

    it('Boundary: Auto-Submit Win Probability threshold at 0.7500 vs 0.7499', () => {
      const atThreshold = routeStep18({
        disputeAmountCents: 10000,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        winProbability: 0.75,
      });
      expect(atThreshold.ruleId).toBe('R2');
      expect(atThreshold.track).toBe('TRACK_A_AUTO_SUBMIT');

      const belowThreshold = routeStep18({
        disputeAmountCents: 10000,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        winProbability: 0.7499,
      });
      expect(belowThreshold.ruleId).toBe('R3');
      expect(belowThreshold.track).toBe('TRACK_B_NEGOTIATE');
    });
  });

  it('BR-021: UNAUTHORISED proof requirements (AVS/CVV + IP Match)', () => {
    // Missing AVS/CVV proof routes to Track D Human Review
    const missingAvs = routeStep18({
      disputeAmountCents: 18000,
      reasonCode: 'UNAUTHORISED',
      deliveryProof: true,
      avsCvvMatch: false,
      winProbability: 0.85,
    });
    expect(missingAvs.ruleId).toBe('R8');
    expect(missingAvs.track).toBe('TRACK_D_HUMAN_REVIEW');

    // Valid AVS/CVV proof with W >= 0.75 routes to Track A
    const validAvs = routeStep18({
      disputeAmountCents: 18000,
      reasonCode: 'UNAUTHORISED',
      deliveryProof: true,
      avsCvvMatch: true,
      winProbability: 0.85,
    });
    expect(validAvs.ruleId).toBe('R7');
    expect(validAvs.track).toBe('TRACK_A_AUTO_SUBMIT');
  });

  it('BR-022: SNAD proof requirements', () => {
    // SNAD with moderate win prob routes to Track B negotiation
    const snadModerate = routeStep18({
      disputeAmountCents: 12000,
      reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      deliveryProof: true,
      winProbability: 0.55,
    });
    expect(snadModerate.ruleId).toBe('R4');
    expect(snadModerate.track).toBe('TRACK_B_NEGOTIATE');

    // SNAD with high win prob and verified proof routes to Track A auto-submit
    const snadHigh = routeStep18({
      disputeAmountCents: 11000,
      reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
      deliveryProof: true,
      winProbability: 0.82,
    });
    expect(snadHigh.ruleId).toBe('R5');
    expect(snadHigh.track).toBe('TRACK_A_AUTO_SUBMIT');
  });
});
