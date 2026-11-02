import { describe, it, expect } from 'vitest';
import { routeStep18, calculateEvCompete } from '../helpers/rule-fixtures';

describe('Tier 5 Adversarial: Step 18 Decision Engine Exact Boundary Tests', () => {
  describe('Boundary 1: High-Value Threshold ($250.00 vs $250.01 / 25000 vs 25001 cents)', () => {
    // 25000 cents is the exact upper ceiling for automated dispute processing (BR-006)
    // 25001 cents must trigger immediate human escalation (Rule R1, Track D)

    const testScenarios = [
      {
        type: 'INR with Verified Delivery Proof (DELIVERED) & W=0.85',
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' as const,
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        avsCvvMatch: false,
        winProbability: 0.85,
        subBoundaryRule: 'R2',
        subBoundaryTrack: 'TRACK_A_AUTO_SUBMIT',
        subBoundaryAction: 'AUTO_SUBMIT_EVIDENCE',
      },
      {
        type: 'SNAD with Verified Delivery Proof & W=0.80',
        reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED' as const,
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        avsCvvMatch: false,
        winProbability: 0.80,
        subBoundaryRule: 'R5',
        subBoundaryTrack: 'TRACK_A_AUTO_SUBMIT',
        subBoundaryAction: 'AUTO_SUBMIT_EVIDENCE',
      },
      {
        type: 'UNAUTHORISED with AVS/CVV Match & W=0.88',
        reasonCode: 'UNAUTHORISED' as const,
        deliveryProof: true,
        deliveryStatus: 'DELIVERED',
        avsCvvMatch: true,
        winProbability: 0.88,
        subBoundaryRule: 'R7',
        subBoundaryTrack: 'TRACK_A_AUTO_SUBMIT',
        subBoundaryAction: 'AUTO_SUBMIT_EVIDENCE',
      },
      {
        type: 'INR with Missing Delivery Proof (IN_TRANSIT) & W=0.40',
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' as const,
        deliveryProof: false,
        deliveryStatus: 'IN_TRANSIT',
        avsCvvMatch: false,
        winProbability: 0.40,
        subBoundaryRule: 'R3',
        subBoundaryTrack: 'TRACK_B_NEGOTIATE',
        subBoundaryAction: 'OFFER_PARTIAL_REFUND',
      },
    ];

    for (const scenario of testScenarios) {
      it(`evaluates ${scenario.type} at $249.99 (24999 cents) -> ${scenario.subBoundaryRule}`, () => {
        const res = routeStep18({
          disputeAmountCents: 24999,
          reasonCode: scenario.reasonCode,
          deliveryProof: scenario.deliveryProof,
          deliveryStatus: scenario.deliveryStatus,
          avsCvvMatch: scenario.avsCvvMatch,
          winProbability: scenario.winProbability,
        });

        expect(res.ruleId).toBe(scenario.subBoundaryRule);
        expect(res.track).toBe(scenario.subBoundaryTrack);
        expect(res.action).toBe(scenario.subBoundaryAction);
      });

      it(`evaluates ${scenario.type} at exact boundary $250.00 (25000 cents) -> ${scenario.subBoundaryRule}`, () => {
        const res = routeStep18({
          disputeAmountCents: 25000,
          reasonCode: scenario.reasonCode,
          deliveryProof: scenario.deliveryProof,
          deliveryStatus: scenario.deliveryStatus,
          avsCvvMatch: scenario.avsCvvMatch,
          winProbability: scenario.winProbability,
        });

        expect(res.ruleId).toBe(scenario.subBoundaryRule);
        expect(res.track).toBe(scenario.subBoundaryTrack);
        expect(res.action).toBe(scenario.subBoundaryAction);
      });

      it(`ESCALATES ${scenario.type} at $250.01 (25001 cents) -> R1 (TRACK_D_HUMAN_REVIEW)`, () => {
        const res = routeStep18({
          disputeAmountCents: 25001,
          reasonCode: scenario.reasonCode,
          deliveryProof: scenario.deliveryProof,
          deliveryStatus: scenario.deliveryStatus,
          avsCvvMatch: scenario.avsCvvMatch,
          winProbability: scenario.winProbability,
        });

        expect(res.ruleId).toBe('R1');
        expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
        expect(res.action).toBe('ESCALATE_TO_HUMAN');
        expect(res.status).toBe('READY_FOR_REVIEW');
      });
    }
  });

  describe('Boundary 2: Auto-Accept Ceiling ($35.00 vs $35.01 / 3500 vs 3501 cents) (BR-017)', () => {
    // Under Rule R6: disputeAmountCents <= 3500 AND winProbability < 0.35 AND EV < 0 -> AUTO_ACCEPT_CLAIM (Track C)

    it('SUCCEEDS R6 at exact boundary: $35.00 (3500 cents) with W=0.20 -> R6 (TRACK_C_AUTO_ACCEPT)', () => {
      const ev = calculateEvCompete(0.20, 3500);
      expect(ev).toBeLessThan(0); // EV = 0.20*3500 - 0.80*1500 - 500 = 700 - 1200 - 500 = -1000

      const res = routeStep18({
        disputeAmountCents: 3500,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.20,
      });

      expect(res.ruleId).toBe('R6');
      expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
      expect(res.action).toBe('AUTO_ACCEPT_CLAIM');
      expect(res.status).toBe('SETTLED_VIA_REFUND');
    });

    it('SUCCEEDS R6 just below boundary: $34.99 (3499 cents) with W=0.20 -> R6 (TRACK_C_AUTO_ACCEPT)', () => {
      const res = routeStep18({
        disputeAmountCents: 3499,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.20,
      });

      expect(res.ruleId).toBe('R6');
      expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
    });

    it('REJECTS R6 at $35.01 (3501 cents) with W=0.20: Exceeds $35 ceiling -> Falls through', () => {
      // For UNAUTHORISED with no AVS match, falls through to R8 (Human Review)
      const resUnauth = routeStep18({
        disputeAmountCents: 3501,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.20,
      });

      expect(resUnauth.ruleId).not.toBe('R6');
      expect(resUnauth.ruleId).toBe('R8');
      expect(resUnauth.track).toBe('TRACK_D_HUMAN_REVIEW');

      // For INR with no delivery proof, falls through to R3 (Negotiate)
      const resInr = routeStep18({
        disputeAmountCents: 3501,
        reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        deliveryProof: false,
        deliveryStatus: 'IN_TRANSIT',
        winProbability: 0.20,
      });

      expect(resInr.ruleId).not.toBe('R6');
      expect(resInr.ruleId).toBe('R3');
      expect(resInr.track).toBe('TRACK_B_NEGOTIATE');
    });

    it('REJECTS R6 at $35.00 if Win Probability is exactly 0.3500 (Strictly < 0.35 required)', () => {
      const res = routeStep18({
        disputeAmountCents: 3500,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.3500,
      });

      // 0.3500 is not < 0.35, so R6 is not triggered
      expect(res.ruleId).not.toBe('R6');
      expect(res.ruleId).toBe('R8');
    });

    it('SUCCEEDS R6 at $35.00 if Win Probability is 0.3499 (< 0.35)', () => {
      const res = routeStep18({
        disputeAmountCents: 3500,
        reasonCode: 'UNAUTHORISED',
        deliveryProof: false,
        winProbability: 0.3499,
      });

      expect(res.ruleId).toBe('R6');
      expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
    });
  });

  describe('Boundary 3: Auto-Submit Win Probability Threshold (W = 0.7500 vs W = 0.7499)', () => {
    describe('INR Dispute (Amount $100.00, Verified DELIVERED proof)', () => {
      it('ROUTES to R2 (Track A Auto-Submit) at exact threshold W = 0.7500', () => {
        const res = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.7500,
        });

        expect(res.ruleId).toBe('R2');
        expect(res.track).toBe('TRACK_A_AUTO_SUBMIT');
        expect(res.action).toBe('AUTO_SUBMIT_EVIDENCE');
        expect(res.status).toBe('SUBMITTED');
      });

      it('ROUTES to R3 (Track B Negotiate) below threshold at W = 0.7499', () => {
        const res = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.7499,
        });

        expect(res.ruleId).toBe('R3');
        expect(res.track).toBe('TRACK_B_NEGOTIATE');
        expect(res.action).toBe('OFFER_PARTIAL_REFUND');
        expect(res.status).toBe('NEGOTIATING');
      });

      it('ROUTES to R2 (Track A Auto-Submit) above threshold at W = 0.7501', () => {
        const res = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.7501,
        });

        expect(res.ruleId).toBe('R2');
        expect(res.track).toBe('TRACK_A_AUTO_SUBMIT');
      });
    });

    describe('SNAD Dispute (Amount $110.00, Verified item description & proof)', () => {
      it('ROUTES to R5 (Track A Auto-Submit) at exact threshold W = 0.7500', () => {
        const res = routeStep18({
          disputeAmountCents: 11000,
          reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
          deliveryProof: true,
          winProbability: 0.7500,
        });

        expect(res.ruleId).toBe('R5');
        expect(res.track).toBe('TRACK_A_AUTO_SUBMIT');
        expect(res.action).toBe('AUTO_SUBMIT_EVIDENCE');
      });

      it('ROUTES to R4 (Track B Negotiate) below threshold at W = 0.7499', () => {
        const res = routeStep18({
          disputeAmountCents: 11000,
          reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
          deliveryProof: true,
          winProbability: 0.7499,
        });

        expect(res.ruleId).toBe('R4');
        expect(res.track).toBe('TRACK_B_NEGOTIATE');
        expect(res.action).toBe('OFFER_PARTIAL_REFUND');
      });
    });

    describe('UNAUTHORISED Dispute (Amount $180.00, AVS/CVV Match)', () => {
      it('ROUTES to R7 (Track A Auto-Submit) at exact threshold W = 0.7500', () => {
        const res = routeStep18({
          disputeAmountCents: 18000,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: true,
          avsCvvMatch: true,
          winProbability: 0.7500,
        });

        expect(res.ruleId).toBe('R7');
        expect(res.track).toBe('TRACK_A_AUTO_SUBMIT');
        expect(res.action).toBe('AUTO_SUBMIT_EVIDENCE');
      });

      it('ROUTES to R8 (Track D Human Review) below threshold at W = 0.7499', () => {
        const res = routeStep18({
          disputeAmountCents: 18000,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: true,
          avsCvvMatch: true,
          winProbability: 0.7499,
        });

        expect(res.ruleId).toBe('R8');
        expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
        expect(res.action).toBe('ESCALATE_TO_HUMAN');
      });
    });
  });
});
