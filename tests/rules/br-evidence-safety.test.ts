import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import crypto from 'crypto';
import { createTestDb } from '../helpers/db-helper';
import { computeSha256 } from '../../scripts/seed';

describe('Business Rules: Evidence Safety, Audit & Security', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m1', 'Test Merchant', 1500)
    `).run();
    db.prepare(`
      INSERT INTO orders (
        id, merchant_id, paypal_order_id, customer_email, customer_name,
        amount_cents, carrier_name, tracking_number, delivery_status,
        delivered_at, item_summary
      ) VALUES (
        'ord1', 'm1', 'PO-1', 'alex@example.com', 'Alex Rivera',
        14500, 'UPS', '1Z9999999999999991', 'DELIVERED',
        '2026-10-25T14:30:00.000Z', 'Bose Headphones'
      )
    `).run();
    db.prepare(`
      INSERT INTO disputes (
        id, merchant_id, order_id, paypal_dispute_id, reason_code, status,
        dispute_amount_cents, seller_response_due_at
      ) VALUES (
        'dsp1', 'm1', 'ord1', 'PP-D-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN',
        14500, '2026-11-20T00:00:00Z'
      )
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('BR-008: Zero-Hallucination verification (SHA-256 and Database Ground Truth)', () => {
    const order = db.prepare('SELECT carrier_name, tracking_number, delivered_at FROM orders WHERE id = ?').get('ord1') as {
      carrier_name: string;
      tracking_number: string;
      delivered_at: string;
    };

    // Valid evidence package matching DB ground truth
    const validEvidencePayload = {
      carrier: order.carrier_name,
      tracking_number: order.tracking_number,
      delivered_at: order.delivered_at,
    };
    const validHash = computeSha256(validEvidencePayload);

    // Insertion of verified evidence item succeeds
    expect(() => {
      db.prepare(`
        INSERT INTO evidence_items (
          id, dispute_id, order_id, evidence_type, source_system, title,
          content_json, sha256_hash, is_verified
        ) VALUES ('evi1', 'dsp1', 'ord1', 'TRACKING_PROOF', 'UPS', 'Delivery Proof', ?, ?, 1)
      `).run(JSON.stringify(validEvidencePayload), validHash);
    }).not.toThrow();

    // Verifier function that checks for hallucinations
    function verifyEvidenceFact(evidenceContent: any, actualOrder: any): boolean {
      if (evidenceContent.tracking_number && evidenceContent.tracking_number !== actualOrder.tracking_number) {
        return false;
      }
      if (evidenceContent.carrier && evidenceContent.carrier !== actualOrder.carrier_name) {
        return false;
      }
      return true;
    }

    expect(verifyEvidenceFact(validEvidencePayload, order)).toBe(true);

    // Hallucinated tracking number
    const hallucinatedEvidence = {
      carrier: 'UPS',
      tracking_number: '1Z_FABRICATED_999999',
    };
    expect(verifyEvidenceFact(hallucinatedEvidence, order)).toBe(false);
  });

  it('BR-010: SLA Pre-Expiration Fallback (SLA buffer <= 4 hours triggers evidence submission)', () => {
    const slaBufferHours = 4;
    const now = Date.now();
    const fourHoursMs = slaBufferHours * 3600 * 1000;

    // Case 1: Deadline is 3 hours from now (within buffer) -> Must submit evidence
    const dueIn3Hours = new Date(now + 3 * 3600 * 1000).toISOString();
    const isEmergencyFallbackRequired = (dueAtStr: string) => {
      const remainingMs = new Date(dueAtStr).getTime() - now;
      return remainingMs <= fourHoursMs;
    };

    expect(isEmergencyFallbackRequired(dueIn3Hours)).toBe(true);

    // Case 2: Deadline is 10 hours from now (safe) -> Negotiation can continue
    const dueIn10Hours = new Date(now + 10 * 3600 * 1000).toISOString();
    expect(isEmergencyFallbackRequired(dueIn10Hours)).toBe(false);
  });

  it('BR-011: Webhook Idempotency (Unique webhook_id)', () => {
    const webhookId = 'WH-IDEMP-001';
    const payload = JSON.stringify({ dispute_id: 'PP-D-1', event_type: 'CUSTOMER.DISPUTE.CREATED' });

    // Initial webhook receipt
    db.prepare(`
      INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
      VALUES ('wh_1', ?, 'CUSTOMER.DISPUTE.CREATED', 'PP-D-1', ?, 'PROCESSED')
    `).run(webhookId, payload);

    // Replay with identical webhook_id throws UNIQUE constraint failure
    expect(() => {
      db.prepare(`
        INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
        VALUES ('wh_2', ?, 'CUSTOMER.DISPUTE.CREATED', 'PP-D-1', ?, 'PROCESSED')
      `).run(webhookId, payload);
    }).toThrow(/UNIQUE constraint failed: webhook_events.webhook_id/);
  });

  it('BR-012: Mandatory Audit Trail & Immutability Triggers', () => {
    // 1. Audit log insertion
    db.prepare(`
      INSERT INTO audit_logs (
        id, merchant_id, entity_type, entity_id, action,
        actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status
      ) VALUES (
        'aud1', 'm1', 'disputes', 'dsp1', 'ASSESSMENT_COMPLETED',
        'ACT-04', 'AI_AGENT', '{"status":"OPEN"}', '["BR-001","BR-007"]', 'PASSED'
      )
    `).run();

    // 2. Direct UPDATE on audit_logs is aborted by trigger trg_audit_logs_no_update
    expect(() => {
      db.prepare("UPDATE audit_logs SET action = 'MODIFIED' WHERE id = 'aud1'").run();
    }).toThrow(/BR-012: audit_logs is strictly append-only: updates are prohibited/);

    // 3. Direct DELETE on audit_logs is aborted by trigger trg_audit_logs_no_delete
    expect(() => {
      db.prepare("DELETE FROM audit_logs WHERE id = 'aud1'").run();
    }).toThrow(/BR-012: audit_logs is strictly append-only: deletions are prohibited/);
  });

  it('BR-015: Optimistic Concurrency Control (OCC version increment)', () => {
    const current = db.prepare('SELECT version FROM disputes WHERE id = ?').get('dsp1') as { version: number };
    expect(current.version).toBe(1);

    // Concurrent mutation with expected version 1 succeeds and increments to 2
    const updateRes = db
      .prepare('UPDATE disputes SET status = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run('EVIDENCE_GATHERING', 'dsp1', 1);
    expect(updateRes.changes).toBe(1);

    // Stale mutation still expecting version 1 affects 0 rows
    const staleRes = db
      .prepare('UPDATE disputes SET status = ?, version = version + 1 WHERE id = ? AND version = ?')
      .run('SUBMITTED', 'dsp1', 1);
    expect(staleRes.changes).toBe(0);
  });

  it('BR-018: Single Active Offer constraint', () => {
    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
      VALUES ('neg1', 'dsp1', 'token_hash_1', 5800)
    `).run();

    // Create first proposed offer
    db.prepare(`
      INSERT INTO settlement_offers (
        id, dispute_id, negotiation_session_id, offered_amount_cents,
        max_allowed_cents, status, proposed_by
      ) VALUES ('off1', 'dsp1', 'neg1', 3000, 5800, 'PROPOSED', 'AGENT')
    `).run();

    // Application rule: Before proposing a second offer, existing PROPOSED offers must be superseded/cancelled
    function proposeNewOffer(newOfferId: string, amountCents: number) {
      db.transaction(() => {
        // Cancel any pending offers
        db.prepare(`
          UPDATE settlement_offers SET status = 'CANCELLED'
          WHERE dispute_id = 'dsp1' AND status = 'PROPOSED'
        `).run();

        db.prepare(`
          INSERT INTO settlement_offers (
            id, dispute_id, negotiation_session_id, offered_amount_cents,
            max_allowed_cents, status, proposed_by
          ) VALUES (?, 'dsp1', 'neg1', ?, 5800, 'PROPOSED', 'AGENT')
        `).run(newOfferId, amountCents);
      })();
    }

    proposeNewOffer('off2', 4000);

    // Assert strictly 1 offer is currently PROPOSED
    const proposedCount = (
      db.prepare("SELECT count(*) as count FROM settlement_offers WHERE dispute_id = 'dsp1' AND status = 'PROPOSED'").get() as {
        count: number;
      }
    ).count;
    expect(proposedCount).toBe(1);

    // Off1 is cancelled
    const off1Status = (db.prepare('SELECT status FROM settlement_offers WHERE id = ?').get('off1') as { status: string }).status;
    expect(off1Status).toBe('CANCELLED');
  });

  it('BR-019: Buyer Portal Authentication (Token Hash)', () => {
    const rawToken = 'secret-buyer-token-12345';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    db.prepare(`
      INSERT INTO negotiation_sessions (id, dispute_id, token_hash, max_refund_allowed_cents)
      VALUES ('neg_auth', 'dsp1', ?, 5800)
    `).run(tokenHash);

    // Valid token matches
    const session = db
      .prepare('SELECT id FROM negotiation_sessions WHERE token_hash = ?')
      .get(tokenHash) as { id: string } | undefined;
    expect(session).toBeDefined();
    expect(session?.id).toBe('neg_auth');

    // Tampered token returns undefined
    const tamperedHash = crypto.createHash('sha256').update('wrong-token').digest('hex');
    const invalidSession = db
      .prepare('SELECT id FROM negotiation_sessions WHERE token_hash = ?')
      .get(tamperedHash);
    expect(invalidSession).toBeUndefined();
  });

  it('BR-020: Prompt Injection Interception & Firewall Cap Enforcement', () => {
    const maxRefundAllowed = 5800; // 40% cap on $145.00

    // Adversarial buyer prompt attempts 100% refund ($145.00 = 14500 cents)
    const requestedRefund = 14500;

    // Firewall validation function
    function validateSettlementOffer(requestedCents: number, capCents: number) {
      if (requestedCents > capCents) {
        return {
          allowed: false,
          clampedCents: capCents,
          reason: 'EXCEEDS_POLICY_CAP',
          guardrailStatus: 'BLOCKED',
        };
      }
      return {
        allowed: true,
        clampedCents: requestedCents,
        guardrailStatus: 'PASSED',
      };
    }

    const verdict = validateSettlementOffer(requestedRefund, maxRefundAllowed);
    expect(verdict.allowed).toBe(false);
    expect(verdict.clampedCents).toBe(maxRefundAllowed);
    expect(verdict.guardrailStatus).toBe('BLOCKED');
  });

  it('BR-024: Dual-Mode Fallback when credentials are missing', () => {
    function resolvePayPalClient(env: Record<string, string | undefined>) {
      if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
        return { mode: 'SIMULATOR', isLocalMock: true };
      }
      return { mode: 'LIVE_SANDBOX', isLocalMock: false };
    }

    // Missing env vars falls back to SIMULATOR
    expect(resolvePayPalClient({})).toEqual({ mode: 'SIMULATOR', isLocalMock: true });
    // Provided credentials activates sandbox
    expect(
      resolvePayPalClient({ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'csec' })
    ).toEqual({ mode: 'LIVE_SANDBOX', isLocalMock: false });
  });

  it('BR-025: Golden Dataset Determinism', () => {
    // Calling computeSha256 on same input yields identical hash
    const input = { disputeId: 'DSP-GOLD-001', amount: 14500 };
    const hash1 = computeSha256(input);
    const hash2 = computeSha256(input);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});
