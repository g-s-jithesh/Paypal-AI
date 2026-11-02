/**
 * ChargebackShield — Dual-Mode PayPal Sandbox & Client Test Suite
 * Validates BR-024 (Zero-Error Fallback), Simulator deterministic responses,
 * and live client credentials handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';
import {
  MockPayPalSimulator,
  LivePayPalClient,
  getPayPalMode,
  getPayPalClient,
  getPayPalBadgeInfo,
  resetPayPalClient,
} from '../../lib/paypal';

describe('PayPal Dual-Mode: MockPayPalSimulator (Offline Resilience)', () => {
  let db: Database;
  let simulator: MockPayPalSimulator;

  beforeEach(() => {
    db = createTestDb();
    simulator = new MockPayPalSimulator(db);
  });

  afterEach(() => {
    db.close();
  });

  it('fetches dispute details for Golden Persona PP-D-GOLD-001', async () => {
    const dispute = await simulator.getDispute('PP-D-GOLD-001');
    expect(dispute).toBeDefined();
    expect(dispute.dispute_id).toBe('PP-D-GOLD-001');
    expect(dispute.dispute_amount.value).toBe('145.00');
    expect(dispute.reason).toBe('MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  });

  it('fetches dispute details with fetchDispute alias matching PROJECT.md interface contract', async () => {
    const dispute = await simulator.fetchDispute('PP-D-GOLD-002');
    expect(dispute.dispute_id).toBe('PP-D-GOLD-002');
    expect(dispute.dispute_amount.value).toBe('85.00');
  });

  it('submits evidence package and verifies submission tracking', async () => {
    const res = await simulator.provideEvidence('PP-D-GOLD-001', {
      evidence_type: 'PROOF_OF_DELIVERY',
      tracking_number: '1Z9999999999999999',
      carrier: 'UPS',
      notes: 'Delivered and signed by Alex Rivera',
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('SUBMIT_EVIDENCE');
    expect(res.paypal_reference_id).toMatch(/^PP-EV-/);

    const submissions = simulator.getSubmittedEvidence('PP-D-GOLD-001');
    expect(submissions.length).toBe(1);
    expect(submissions[0].tracking_number).toBe('1Z9999999999999999');
  });

  it('proposes settlement offer and records offer payload', async () => {
    const res = await simulator.makeOffer('PP-D-GOLD-003', {
      amount_cents: 4800,
      note: 'Autonomous 40% settlement offer',
    });

    expect(res.success).toBe(true);
    expect(res.action).toBe('MAKE_OFFER');
    expect(res.offer_amount?.value).toBe('48.00');
    expect(res.paypal_reference_id).toMatch(/^PP-OFF-/);

    const offers = simulator.getOffers('PP-D-GOLD-003');
    expect(offers.length).toBe(1);
  });

  it('accepts claim and flags dispute as resolved', async () => {
    const res = await simulator.acceptClaim('PP-D-GOLD-005', 'Low-value claim auto-accepted');
    expect(res.success).toBe(true);
    expect(res.action).toBe('ACCEPT_CLAIM');
    expect(res.status).toBe('CLAIM_ACCEPTED');
    expect(simulator.isClaimAccepted('PP-D-GOLD-005')).toBe(true);
  });

  it('retrieves order details for simulated order', async () => {
    const order = await simulator.getOrder('ORD-TEST-1');
    expect(order).toBeDefined();
    expect(order.status).toBe('COMPLETED');
  });

  it('throws error for unknown dispute', async () => {
    await expect(simulator.getDispute('NON_EXISTENT_DISPUTE_XYZ')).rejects.toThrow(
      /PayPal Dispute NON_EXISTENT_DISPUTE_XYZ not found in simulator/
    );
  });
});

describe('PayPal Dual-Mode: Factory & Mode Detection (BR-024)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetPayPalClient();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPayPalClient();
  });

  it('defaults to sandbox_simulated when credentials are mock or missing (BR-024 zero-error fallback)', () => {
    process.env.PAYPAL_MODE = 'sandbox_simulated';
    process.env.PAYPAL_CLIENT_ID = 'sb-client-mock-12345';
    process.env.PAYPAL_CLIENT_SECRET = 'sb-secret-mock-67890';

    expect(getPayPalMode()).toBe('sandbox_simulated');
    const client = getPayPalClient();
    expect(client).toBeInstanceOf(MockPayPalSimulator);
  });

  it('detects sandbox_live when live credentials are provided', () => {
    process.env.PAYPAL_MODE = 'sandbox_live';
    process.env.PAYPAL_CLIENT_ID = 'AXYZ_REAL_SANDBOX_CLIENT_ID_123';
    process.env.PAYPAL_CLIENT_SECRET = 'EXYZ_REAL_SANDBOX_SECRET_456';

    expect(getPayPalMode()).toBe('sandbox_live');
    const client = getPayPalClient();
    expect(client).toBeInstanceOf(LivePayPalClient);
  });

  it('provides correct UI status badge info for both modes', () => {
    process.env.PAYPAL_MODE = 'sandbox_simulated';
    process.env.PAYPAL_CLIENT_ID = '';
    const simBadge = getPayPalBadgeInfo();
    expect(simBadge.isLive).toBe(false);
    expect(simBadge.color).toBe('emerald');
    expect(simBadge.label).toContain('Local Simulator');

    process.env.PAYPAL_MODE = 'sandbox_live';
    process.env.PAYPAL_CLIENT_ID = 'REAL_LIVE_CLIENT';
    process.env.PAYPAL_CLIENT_SECRET = 'REAL_LIVE_SECRET';
    const liveBadge = getPayPalBadgeInfo();
    expect(liveBadge.isLive).toBe(true);
    expect(liveBadge.color).toBe('blue');
    expect(liveBadge.label).toContain('Live Sandbox');
  });
});
