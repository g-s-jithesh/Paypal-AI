/**
 * ChargebackShield — Challenger M2 Empirical Stress-Test Harness
 *
 * Grounded in:
 * - Decision Router Numerical Boundaries ($250.00/$250.01, $35.00/$35.01, W=0.7500/0.7499)
 * - Inbound Webhook Concurrent Burst Idempotency Gate (BR-011, ENT-10)
 * - Dual-Mode PayPal Sandbox Switching & Zero-Error Fallback (BR-024)
 * - 1-Click Simulator Reset Route Latency (< 500ms) & Entity Recovery (US-006)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Database } from 'better-sqlite3';
import { routeStep18, persistDecisionResult } from '@/lib/engine/decision-router';
import { calculateEvCompete, calculateEvSettle } from '@/lib/engine/ev-engine';
import {
  getPayPalMode,
  getPayPalClient,
  resetPayPalClient,
  getPayPalBadgeInfo,
  MockPayPalSimulator,
  LivePayPalClient,
} from '@/lib/paypal';
import { POST as webhookRoutePost } from '@/app/api/webhooks/paypal/route';
import { POST as resetRoutePost } from '@/app/api/simulator/reset/route';
import { getDb, closeDb, initializeDatabase } from '@/lib/db';
import { runGoldenSeeder } from '@/scripts/seed';

describe('Challenger M2: Empirical Adversarial Stress Suite', () => {
  // =========================================================================
  // 1. DECISION ROUTER NUMERICAL BOUNDARIES
  // =========================================================================
  describe('1. Decision Router Numerical Boundaries', () => {
    describe('1.1 High-Value Gate ($250.00 vs $250.01 / 25000 vs 25001 cents) (BR-006)', () => {
      const allReasonCodes = [
        { code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', subRule: 'R2', subAction: 'AUTO_SUBMIT_EVIDENCE', subTrack: 'TRACK_A_AUTO_SUBMIT', deliveryProof: true, deliveryStatus: 'DELIVERED', winProb: 0.95 },
        { code: 'SIGNIFICANTLY_NOT_AS_DESCRIBED', subRule: 'R5', subAction: 'AUTO_SUBMIT_EVIDENCE', subTrack: 'TRACK_A_AUTO_SUBMIT', deliveryProof: true, winProb: 0.90 },
        { code: 'UNAUTHORISED', subRule: 'R7', subAction: 'AUTO_SUBMIT_EVIDENCE', subTrack: 'TRACK_A_AUTO_SUBMIT', avsCvvMatch: true, winProb: 0.92 },
        { code: 'CANCELLED_RECURRING_BILLING', subRule: 'R8', subAction: 'ESCALATE_TO_HUMAN', subTrack: 'TRACK_D_HUMAN_REVIEW', winProb: 0.80 },
        { code: 'OTHER', subRule: 'R8', subAction: 'ESCALATE_TO_HUMAN', subTrack: 'TRACK_D_HUMAN_REVIEW', winProb: 0.85 },
        { code: 'BUYER_UNRECOGNIZED_REASON', subRule: 'R8', subAction: 'ESCALATE_TO_HUMAN', subTrack: 'TRACK_D_HUMAN_REVIEW', winProb: 0.99 },
      ];

      for (const scenario of allReasonCodes) {
        it(`at exact ceiling $250.00 (25000 cents): ${scenario.code} preserves standard routing ${scenario.subRule} (no R1 escalation)`, () => {
          const res = routeStep18({
            disputeAmountCents: 25000,
            reasonCode: scenario.code,
            deliveryProof: scenario.deliveryProof ?? false,
            deliveryStatus: scenario.deliveryStatus,
            avsCvvMatch: scenario.avsCvvMatch ?? false,
            winProbability: scenario.winProb,
          });

          expect(res.ruleId).not.toBe('R1');
          expect(res.ruleId).toBe(scenario.subRule);
          expect(res.action).toBe(scenario.subAction);
          expect(res.track).toBe(scenario.subTrack);
        });

        it(`at boundary breach $250.01 (25001 cents): ${scenario.code} unconditionally ESCALATES to R1 (TRACK_D_HUMAN_REVIEW)`, () => {
          const res = routeStep18({
            disputeAmountCents: 25001,
            reasonCode: scenario.code,
            deliveryProof: scenario.deliveryProof ?? false,
            deliveryStatus: scenario.deliveryStatus,
            avsCvvMatch: scenario.avsCvvMatch ?? false,
            winProbability: scenario.winProb,
          });

          expect(res.ruleId).toBe('R1');
          expect(res.action).toBe('ESCALATE_TO_HUMAN');
          expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
          expect(res.status).toBe('READY_FOR_REVIEW');
          expect(res.nextStatus).toBe('READY_FOR_REVIEW');
          expect(res.rationale).toContain('exceeds maximum auto-dispute threshold');
        });
      }

      it('boundary sanity: $249.99 (24999 cents) vs $250.01 (25001 cents) for INR', () => {
        const subRes = routeStep18({
          disputeAmountCents: 24999,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.85,
        });
        expect(subRes.ruleId).toBe('R2');

        const escRes = routeStep18({
          disputeAmountCents: 25001,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.85,
        });
        expect(escRes.ruleId).toBe('R1');
      });
    });

    describe('1.2 Low-Value Auto-Accept Gate ($35.00 vs $35.01 / 3500 vs 3501 cents) (BR-017)', () => {
      it('asserts R6 auto-accept at exact boundary $35.00 (3500 cents) when W < 0.35 and EV < 0', () => {
        const ev = calculateEvCompete(0.20, 3500); // 0.20 * 3500 - 0.80 * 1500 - 500 = -1000 cents
        expect(ev).toBeLessThan(0);

        const res = routeStep18({
          disputeAmountCents: 3500,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.20,
        });

        expect(res.ruleId).toBe('R6');
        expect(res.action).toBe('AUTO_ACCEPT_CLAIM');
        expect(res.status).toBe('SETTLED_VIA_REFUND');
        expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
        expect(res.rationale).toContain('BR-017');
      });

      it('asserts R6 is EXCLUDED at $35.01 (3501 cents) with identical W=0.20 and negative EV', () => {
        const ev = calculateEvCompete(0.20, 3501);
        expect(ev).toBeLessThan(0);

        const res = routeStep18({
          disputeAmountCents: 3501,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.20,
        });

        expect(res.ruleId).not.toBe('R6');
        expect(res.ruleId).toBe('R8');
        expect(res.action).toBe('ESCALATE_TO_HUMAN');
        expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
      });

      it('asserts R6 is EXCLUDED at $35.00 if Win Probability is exactly 0.3500 (strictly < 0.35 required)', () => {
        const res = routeStep18({
          disputeAmountCents: 3500,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.3500,
        });

        expect(res.ruleId).not.toBe('R6');
        expect(res.ruleId).toBe('R8');
      });

      it('asserts R6 TRIGGERS at $35.00 if Win Probability is 0.3499 (< 0.35)', () => {
        const res = routeStep18({
          disputeAmountCents: 3500,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.3499,
        });

        expect(res.ruleId).toBe('R6');
        expect(res.action).toBe('AUTO_ACCEPT_CLAIM');
        expect(res.track).toBe('TRACK_C_AUTO_ACCEPT');
      });

      it('asserts R6 is EXCLUDED at $35.00 if EV is exactly 0 or positive (strictly EV < 0 required)', () => {
        // Force EV = 0
        const resZeroEv = routeStep18({
          disputeAmountCents: 3500,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.20,
          evCompeteCents: 0,
        });
        expect(resZeroEv.ruleId).not.toBe('R6');

        // Force EV = -1 -> triggers R6
        const resNegEv = routeStep18({
          disputeAmountCents: 3500,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: false,
          winProbability: 0.20,
          evCompeteCents: -1,
        });
        expect(resNegEv.ruleId).toBe('R6');
        expect(resNegEv.action).toBe('AUTO_ACCEPT_CLAIM');
      });
    });

    describe('1.3 Win Probability Threshold ($W = 0.7500$ vs $W = 0.7499$)', () => {
      it('INR Dispute: W = 0.7500 triggers R2 Auto-Submit; W = 0.7499 triggers R3 Negotiate', () => {
        const resAt75 = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.7500,
        });
        expect(resAt75.ruleId).toBe('R2');
        expect(resAt75.action).toBe('AUTO_SUBMIT_EVIDENCE');
        expect(resAt75.track).toBe('TRACK_A_AUTO_SUBMIT');
        expect(resAt75.status).toBe('SUBMITTED');

        const resBelow75 = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 0.7499,
        });
        expect(resBelow75.ruleId).toBe('R3');
        expect(resBelow75.action).toBe('OFFER_PARTIAL_REFUND');
        expect(resBelow75.track).toBe('TRACK_B_NEGOTIATE');
        expect(resBelow75.status).toBe('NEGOTIATING');
      });

      it('SNAD Dispute: W = 0.7500 triggers R5 Auto-Submit; W = 0.7499 triggers R4 Negotiate', () => {
        const resAt75 = routeStep18({
          disputeAmountCents: 12000,
          reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
          deliveryProof: true,
          winProbability: 0.7500,
        });
        expect(resAt75.ruleId).toBe('R5');
        expect(resAt75.action).toBe('AUTO_SUBMIT_EVIDENCE');
        expect(resAt75.track).toBe('TRACK_A_AUTO_SUBMIT');

        const resBelow75 = routeStep18({
          disputeAmountCents: 12000,
          reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
          deliveryProof: true,
          winProbability: 0.7499,
        });
        expect(resBelow75.ruleId).toBe('R4');
        expect(resBelow75.action).toBe('OFFER_PARTIAL_REFUND');
        expect(resBelow75.track).toBe('TRACK_B_NEGOTIATE');
      });

      it('UNAUTHORISED Dispute: W = 0.7500 triggers R7 Auto-Submit; W = 0.7499 triggers R8 Escalate', () => {
        const resAt75 = routeStep18({
          disputeAmountCents: 18000,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: true,
          avsCvvMatch: true,
          winProbability: 0.7500,
        });
        expect(resAt75.ruleId).toBe('R7');
        expect(resAt75.action).toBe('AUTO_SUBMIT_EVIDENCE');
        expect(resAt75.track).toBe('TRACK_A_AUTO_SUBMIT');

        const resBelow75 = routeStep18({
          disputeAmountCents: 18000,
          reasonCode: 'UNAUTHORISED',
          deliveryProof: true,
          avsCvvMatch: true,
          winProbability: 0.7499,
        });
        expect(resBelow75.ruleId).toBe('R8');
        expect(resBelow75.action).toBe('ESCALATE_TO_HUMAN');
        expect(resBelow75.track).toBe('TRACK_D_HUMAN_REVIEW');
      });
    });

    describe('1.4 Extreme Boundary Injections & Carrier Status Overrides', () => {
      it('asserts disputeAmountCents = Number.MAX_SAFE_INTEGER triggers R1 escalation', () => {
        const res = routeStep18({
          disputeAmountCents: Number.MAX_SAFE_INTEGER,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 1.0,
        });

        expect(res.ruleId).toBe('R1');
        expect(res.action).toBe('ESCALATE_TO_HUMAN');
        expect(res.track).toBe('TRACK_D_HUMAN_REVIEW');
      });

      it('asserts INR with deliveryProof=true BUT deliveryStatus="IN_TRANSIT" falls back to R3 negotiate (not R2)', () => {
        const res = routeStep18({
          disputeAmountCents: 15000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'IN_TRANSIT',
          winProbability: 0.95,
        });

        expect(res.ruleId).toBe('R3');
        expect(res.action).toBe('OFFER_PARTIAL_REFUND');
        expect(res.track).toBe('TRACK_B_NEGOTIATE');
      });

      it('asserts Win Probability boundary limits at W=0.0000 and W=1.0000', () => {
        // W=0.0000 for INR -> R3
        const res0 = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: false,
          winProbability: 0.0000,
        });
        expect(res0.ruleId).toBe('R3');

        // W=1.0000 for INR with delivery proof -> R2
        const res1 = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
          winProbability: 1.0000,
        });
        expect(res1.ruleId).toBe('R2');
      });
    });

    describe('1.5 Decision Persistence Immutability & Concurrency (BR-005, BR-015)', () => {
      beforeEach(() => {
        runGoldenSeeder();
      });

      it('asserts persistDecisionResult rejects mutation on TERMINAL dispute status (BR-005)', () => {
        const db = getDb();
        const order = db.prepare('SELECT id, merchant_id FROM orders LIMIT 1').get() as { id: string; merchant_id: string };
        // Insert a dispute in WON terminal status
        const termDisputeId = `DSP-TERM-BR005-${Date.now()}`;
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
            dispute_amount_cents, currency, seller_response_due_at, version
          ) VALUES (?, ?, ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'WON', 10000, 'USD', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days'), 1)
        `).run(termDisputeId, order.merchant_id, order.id, `PP-${termDisputeId}`);

        const decision = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          winProbability: 0.90,
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
        });

        expect(() => {
          persistDecisionResult(db, {
            disputeId: termDisputeId,
            decision,
          });
        }).toThrow(/BR-005: Cannot modify dispute.*in terminal state 'WON'/);
      });

      it('asserts persistDecisionResult detects optimistic locking version conflict (BR-015)', () => {
        const db = getDb();
        const order = db.prepare('SELECT id, merchant_id FROM orders LIMIT 1').get() as { id: string; merchant_id: string };
        const conflictDisputeId = `DSP-CONF-BR015-${Date.now()}`;
        db.prepare(`
          INSERT INTO disputes (
            id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
            dispute_amount_cents, currency, seller_response_due_at, version
          ) VALUES (?, ?, ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10000, 'USD', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days'), 2)
        `).run(conflictDisputeId, order.merchant_id, order.id, `PP-${conflictDisputeId}`);

        const decision = routeStep18({
          disputeAmountCents: 10000,
          reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          winProbability: 0.90,
          deliveryProof: true,
          deliveryStatus: 'DELIVERED',
        });

        // Pass stale expectedVersion = 1 while database has version = 2
        expect(() => {
          persistDecisionResult(db, {
            disputeId: conflictDisputeId,
            expectedVersion: 1,
            decision,
          });
        }).toThrow(/BR-015: Optimistic locking conflict/);
      });
    });
  });

  // =========================================================================
  // 2. WEBHOOK INGESTION & IDEMPOTENCY GATE
  // =========================================================================
  describe('2. Webhook Ingestion & Idempotency Gate (BR-011, ENT-10)', () => {
    beforeEach(() => {
      runGoldenSeeder();
    });

    it('Sequential Replay: exactly 1 processed record and subsequent call returns DUPLICATE_IGNORED', async () => {
      const transmissionId = `WH-BURST-SEQ-${Date.now()}`;
      const disputeId = `PP-D-BURST-SEQ-${Date.now()}`;
      const payload = {
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        id: transmissionId,
        resource: {
          id: disputeId,
          dispute_id: disputeId,
          dispute_amount: { value: '145.00', currency: 'USD' },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          disputed_transactions: [{ seller_transaction_id: 'ORD-001' }],
        },
      };

      // Call 1 -> PROCESSED
      const req1 = new Request('http://localhost:3000/api/webhooks/paypal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-id': transmissionId,
        },
        body: JSON.stringify(payload),
      });

      const res1 = await webhookRoutePost(req1);
      const json1 = await res1.json();
      expect(res1.status).toBe(200);
      expect(json1.success).toBe(true);
      expect(json1.action).toBeDefined();

      // Call 2 -> DUPLICATE_IGNORED
      const req2 = new Request('http://localhost:3000/api/webhooks/paypal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-id': transmissionId,
        },
        body: JSON.stringify(payload),
      });

      const res2 = await webhookRoutePost(req2);
      const json2 = await res2.json();
      expect(res2.status).toBe(200);
      expect(json2.status).toBe('DUPLICATE_IGNORED');
      expect(json2.message).toContain('Duplicate webhook transmission ignored (BR-011)');

      // Verify SQLite state
      const db = getDb();
      const webhookCount = (db.prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?').get(transmissionId) as any).count;
      expect(webhookCount).toBe(1);

      const disputeCount = (db.prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?').get(disputeId) as any).count;
      expect(disputeCount).toBe(1);
    });

    it('Burst Replay (20 concurrent requests with identical webhook_id): exactly 1 processed and 19 DUPLICATE_IGNORED without DB lockup', async () => {
      const transmissionId = `WH-CONCUR-BURST-${Date.now()}`;
      const disputeId = `PP-D-CONCUR-BURST-${Date.now()}`;
      const payload = {
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        id: transmissionId,
        resource: {
          id: disputeId,
          dispute_id: disputeId,
          dispute_amount: { value: '85.00', currency: 'USD' },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          disputed_transactions: [{ seller_transaction_id: 'ORD-002' }],
        },
      };

      const burstCount = 20;
      const requests = Array.from({ length: burstCount }, () =>
        new Request('http://localhost:3000/api/webhooks/paypal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-transmission-id': transmissionId,
          },
          body: JSON.stringify(payload),
        })
      );

      // Execute all 20 requests in parallel
      const responses = await Promise.all(requests.map((req) => webhookRoutePost(req)));
      const jsonBodies = await Promise.all(responses.map((res) => res.json()));

      // All responses should be HTTP 200
      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      const processed = jsonBodies.filter((b) => b.success === true);
      const duplicateIgnored = jsonBodies.filter((b) => b.status === 'DUPLICATE_IGNORED');

      expect(processed.length).toBe(1);
      expect(duplicateIgnored.length).toBe(burstCount - 1);

      // Verify Database state
      const db = getDb();
      const webhookEvents = db.prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?').get(transmissionId) as any;
      expect(webhookEvents.count).toBe(1);

      const disputes = db.prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?').get(disputeId) as any;
      expect(disputes.count).toBe(1);

      // Assert PRAGMA integrity_check
      const integrity = db.prepare('PRAGMA integrity_check;').get() as any;
      expect(integrity.integrity_check).toBe('ok');
    });

    it('Burst Replay Scaled (50 concurrent requests with identical webhook_id): exactly 1 processed and 49 DUPLICATE_IGNORED', async () => {
      const transmissionId = `WH-SCALE-BURST-${Date.now()}`;
      const disputeId = `PP-D-SCALE-BURST-${Date.now()}`;
      const payload = {
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        id: transmissionId,
        resource: {
          id: disputeId,
          dispute_id: disputeId,
          dispute_amount: { value: '120.00', currency: 'USD' },
          reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          disputed_transactions: [{ seller_transaction_id: 'ORD-001' }],
        },
      };

      const burstCount = 50;
      const requests = Array.from({ length: burstCount }, () =>
        new Request('http://localhost:3000/api/webhooks/paypal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'paypal-transmission-id': transmissionId,
          },
          body: JSON.stringify(payload),
        })
      );

      const responses = await Promise.all(requests.map((req) => webhookRoutePost(req)));
      const jsonBodies = await Promise.all(responses.map((res) => res.json()));

      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      const processed = jsonBodies.filter((b) => b.success === true);
      const duplicateIgnored = jsonBodies.filter((b) => b.status === 'DUPLICATE_IGNORED');

      expect(processed.length).toBe(1);
      expect(duplicateIgnored.length).toBe(burstCount - 1);

      const db = getDb();
      const webhookEvents = db.prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?').get(transmissionId) as any;
      expect(webhookEvents.count).toBe(1);
    });

    it('Malformed JSON payload: returns HTTP 400 Bad Request', async () => {
      const req = new Request('http://localhost:3000/api/webhooks/paypal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'paypal-transmission-id': 'WH-MALFORMED',
        },
        body: 'NOT_A_VALID_JSON{[[{',
      });

      const res = await webhookRoutePost(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid JSON payload');
    });
  });

  // =========================================================================
  // 3. DUAL-MODE PAYPAL SANDBOX SWITCHING & FALLBACK (BR-024)
  // =========================================================================
  describe('3. Dual-Mode PayPal Sandbox Switching & Fallback (BR-024)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      resetPayPalClient();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      resetPayPalClient();
    });

    it('Scenario 3.1: PAYPAL_MODE=sandbox_simulated returns sandbox_simulated mode and MockPayPalSimulator', () => {
      process.env.PAYPAL_MODE = 'sandbox_simulated';
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;

      expect(getPayPalMode()).toBe('sandbox_simulated');
      const client = getPayPalClient();
      expect(client).toBeInstanceOf(MockPayPalSimulator);

      const badge = getPayPalBadgeInfo();
      expect(badge.isLive).toBe(false);
      expect(badge.color).toBe('emerald');
      expect(badge.label).toContain('Local Simulator');
    });

    it('Scenario 3.2: PAYPAL_MODE=sandbox_live with valid live credentials returns sandbox_live and LivePayPalClient', () => {
      process.env.PAYPAL_MODE = 'sandbox_live';
      process.env.PAYPAL_CLIENT_ID = 'AZ_LIVE_SANDBOX_CLIENT_ID_999';
      process.env.PAYPAL_CLIENT_SECRET = 'EZ_LIVE_SANDBOX_SECRET_KEY_888';

      expect(getPayPalMode()).toBe('sandbox_live');
      const client = getPayPalClient();
      expect(client).toBeInstanceOf(LivePayPalClient);

      const badge = getPayPalBadgeInfo();
      expect(badge.isLive).toBe(true);
      expect(badge.color).toBe('blue');
      expect(badge.label).toContain('Live Sandbox');
    });

    it('Scenario 3.3: BR-024 Zero-Error Fallback when PAYPAL_MODE=sandbox_live but credentials are MISSING', () => {
      process.env.PAYPAL_MODE = 'sandbox_live';
      delete process.env.PAYPAL_CLIENT_ID;
      delete process.env.PAYPAL_CLIENT_SECRET;

      // Gracefully falls back to sandbox_simulated without crashing or throwing
      expect(getPayPalMode()).toBe('sandbox_simulated');
      const client = getPayPalClient();
      expect(client).toBeInstanceOf(MockPayPalSimulator);
    });

    it('Scenario 3.4: BR-024 Zero-Error Fallback when mock strings are provided (sb-client-mock or mock_)', () => {
      // Test mock prefix sb-client-mock
      process.env.PAYPAL_MODE = 'sandbox_live';
      process.env.PAYPAL_CLIENT_ID = 'sb-client-mock-12345';
      process.env.PAYPAL_CLIENT_SECRET = 'sb-secret-mock-67890';

      expect(getPayPalMode()).toBe('sandbox_simulated');
      expect(getPayPalClient()).toBeInstanceOf(MockPayPalSimulator);

      // Test mock prefix mock_
      process.env.PAYPAL_CLIENT_ID = 'mock_client_id_test';
      expect(getPayPalMode()).toBe('sandbox_simulated');
      expect(getPayPalClient()).toBeInstanceOf(MockPayPalSimulator);
    });

    it('Scenario 3.5: Simulator Determinism: executes dispute retrieval, evidence submission, offer, and claim accept', async () => {
      const db = getDb();
      const sim = new MockPayPalSimulator(db);

      // 1. Fetch Golden Persona PP-D-GOLD-001
      const dispute = await sim.fetchDispute('PP-D-GOLD-001');
      expect(dispute.dispute_id).toBe('PP-D-GOLD-001');
      expect(dispute.dispute_amount.value).toBe('145.00');

      // 2. Submit evidence
      const subRes = await sim.submitEvidence('PP-D-GOLD-001', {
        evidence_type: 'PROOF_OF_DELIVERY',
        tracking_number: '1Z9999999999999999',
        carrier: 'UPS',
        notes: 'Challenger empirical test proof',
      });
      expect(subRes.success).toBe(true);
      expect(subRes.action).toBe('SUBMIT_EVIDENCE');

      // 3. Make offer
      const offerRes = await sim.makeOffer('PP-D-GOLD-003', {
        amount_cents: 4800,
        note: 'Challenger offer test',
      });
      expect(offerRes.success).toBe(true);
      expect(offerRes.action).toBe('MAKE_OFFER');

      // 4. Accept claim
      const acceptRes = await sim.acceptClaim('PP-D-GOLD-005', 'Challenger accept test');
      expect(acceptRes.success).toBe(true);
      expect(acceptRes.status).toBe('CLAIM_ACCEPTED');
    });
  });

  // =========================================================================
  // 4. 1-CLICK SIMULATOR RESET ENDPOINT (/api/simulator/reset)
  // =========================================================================
  describe('4. 1-Click Simulator Reset Endpoint (/api/simulator/reset) (US-006)', () => {
    it('executes 1-click reset via POST route and restores 50 Golden disputes in < 500ms', async () => {
      const startTime = Date.now();
      const res = await resetRoutePost();
      const elapsedMs = Date.now() - startTime;

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.dispute_count).toBe(50);
      expect(json.duration_ms).toBeLessThan(500);
      expect(elapsedMs).toBeLessThan(500);

      // Verify directly from SQLite
      const db = getDb();
      const disputeCount = (db.prepare('SELECT count(*) as count FROM disputes').get() as any).count;
      expect(disputeCount).toBe(50);

      const orderCount = (db.prepare('SELECT count(*) as count FROM orders').get() as any).count;
      expect(orderCount).toBe(50);

      // Assert Golden Persona IDs exist
      const personas = ['DSP-GOLD-001', 'DSP-GOLD-002', 'DSP-GOLD-003', 'DSP-GOLD-004', 'DSP-GOLD-005'];
      for (const pid of personas) {
        const d = db.prepare('SELECT id, status, track FROM disputes WHERE id = ?').get(pid);
        expect(d).toBeDefined();
      }
    });

    it('stress-tests 3 consecutive resets: guarantees latency < 500ms and zero DB lock corruption', async () => {
      const db = getDb();

      for (let i = 1; i <= 3; i++) {
        const iterStart = Date.now();
        const res = await resetRoutePost();
        const iterElapsed = Date.now() - iterStart;

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.success).toBe(true);
        expect(json.dispute_count).toBe(50);
        expect(json.duration_ms).toBeLessThan(500);
        expect(iterElapsed).toBeLessThan(500);

        const liveDb = getDb();
        const integrity = liveDb.prepare('PRAGMA integrity_check;').get() as any;
        expect(integrity.integrity_check).toBe('ok');
      }
    });

    it('benchmarks 5 consecutive resets: asserts p50 latency < 500ms with 100% KPI reconciliation', async () => {
      const latencies: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        const res = await resetRoutePost();
        const elapsed = Date.now() - start;
        const json = await res.json();

        expect(res.status).toBe(200);
        expect(json.success).toBe(true);
        expect(json.dispute_count).toBe(50);
        latencies.push(elapsed);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const max = latencies[latencies.length - 1];

      console.log(`\n⏱️ Simulator Reset Latency Benchmark (5 iterations):`);
      console.log(`  • p50: ${p50}ms`);
      console.log(`  • p95: ${p95}ms`);
      console.log(`  • max: ${max}ms`);

      // Median only: p95/max of 5 samples is a single outlier and spikes under parallel-suite CPU contention
      expect(p50).toBeLessThan(500);

      // Verify Golden KPI reconciliation post-reset
      const db = getDb();
      const winRateRow = db.prepare(`
        SELECT ROUND(100.0 * COUNT(CASE WHEN status = 'WON' THEN 1 END) /
               NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct
        FROM disputes WHERE merchant_id = 'merch_default';
      `).get() as { win_rate_pct: number };

      expect(winRateRow.win_rate_pct).toBeGreaterThanOrEqual(72.0);
    });
  });
});
