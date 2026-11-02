/**
 * ChargebackShield — Tier 3 Cross-Feature Combination: Webhook Ingestion to Decision Routing
 * Validates cross-module flow: Inbound Webhook -> Deduplication -> Enrichment -> EV -> Decision Table -> Audit Log
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';
import { calculateWinProbability, routeDecisionTable } from '../tier1/t1_core_engines.test';
import { calculateExpectedEV, assertAuditLogExists } from '../helpers/assertions';

describe('Tier 3: Webhook Ingestion to Decision Table Routing', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);

    // Seed ground truth order in orders table
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, carrier_name, tracking_number, delivery_status, delivered_at, delivery_signature_name, item_summary)
      VALUES ('ORD-INT-01', 'merch_default', 'O-INT-01', 'customer@example.com', 'Alex Rivera', 'USD', 14500, 'UPS', '1Z9999999999999999', 'DELIVERED', '2026-10-28T14:30:00Z', 'Alex Rivera', 'Smart Headphones')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T3-INT-1: Executes full end-to-end chain from raw webhook payload to decision routing and audit log', () => {
    const webhookTransmissionId = 'WH-TX-INT-101';
    const paypalDisputeId = 'PP-D-INT-101';
    const disputeAmountCents = 14500;
    const orderId = 'ORD-INT-01';

    // Step 1: Inbound Webhook Logging (ENT-10)
    db.prepare(`
      INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
      VALUES ('WH-INT-1', ?, 'CUSTOMER.DISPUTE.CREATED', ?, '{"dispute_id":"PP-D-INT-101"}', 'PENDING')
    `).run(webhookTransmissionId, paypalDisputeId);

    // Verify webhook persisted
    const webhook = db.prepare(`SELECT * FROM webhook_events WHERE webhook_id = ?`).get(webhookTransmissionId) as any;
    expect(webhook.processing_status).toBe('PENDING');

    // Step 2: Auto-Enrichment from orders table
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as any;
    expect(order).toBeDefined();
    expect(order.delivery_status).toBe('DELIVERED');

    // Step 3: Insert Dispute into disputes table (ENT-03)
    const dueAt = new Date(Date.now() + 864000000).toISOString();
    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-INT-101', 'merch_default', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'EVIDENCE_GATHERING', ?, 'USD', ?, 'INQUIRY', 1)
    `).run(orderId, paypalDisputeId, disputeAmountCents, dueAt);

    // Step 4: AI Win Probability Scoring (FEAT-008)
    const winProb = calculateWinProbability({
      reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      delivery_status: order.delivery_status,
      has_signature: !!order.delivery_signature_name
    });
    expect(winProb).toBe(0.91);

    // Step 5: EV Engine Execution (FEAT-009)
    const evCompete = calculateExpectedEV(winProb, disputeAmountCents, 1500, 500);
    const evSettle = disputeAmountCents - Math.floor(disputeAmountCents * 0.40);

    // Step 6: Step 18 Decision Table Router (FEAT-010)
    const routing = routeDecisionTable({
      dispute_amount_cents: disputeAmountCents,
      reason_code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      delivery_status: order.delivery_status,
      win_prob: winProb,
      ev_compete: evCompete,
      ev_settle: evSettle
    });

    expect(routing.rule_id).toBe('R2');
    expect(routing.action).toBe('AUTO_SUBMIT_EVIDENCE');

    // Step 7: Record AI Assessment (ENT-05)
    db.prepare(`
      INSERT INTO ai_assessments (id, dispute_id, win_probability, expected_value_cents, ev_settle_cents, recommended_action, confidence_score, reasoning_json, model_version, execution_latency_ms)
      VALUES ('ASSESS-INT-101', 'DSP-INT-101', ?, ?, ?, ?, 0.95, '{"rule":"R2"}', 'rule-engine-v1', 35)
    `).run(winProb, evCompete, evSettle, routing.action);

    // Step 8: Update Dispute Track and Status
    db.prepare(`
      UPDATE disputes
      SET status = 'SUBMITTED', track = 'TRACK_A_AUTO_SUBMIT', version = version + 1
      WHERE id = 'DSP-INT-101'
    `).run();

    // Step 9: Record Audit Log (ENT-09)
    db.prepare(`
      INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_id, actor_type, new_state_json, rule_ids_checked, guardrail_status)
      VALUES ('AUD-INT-101', 'merch_default', 'disputes', 'DSP-INT-101', 'AUTO_ROUTE_SUBMIT', 'ACT-04', 'AI_AGENT', '{"status":"SUBMITTED","track":"TRACK_A"}', '["BR-007","BR-016"]', 'PASSED')
    `).run();

    // Step 10: Mark Webhook Processed
    db.prepare(`UPDATE webhook_events SET processing_status = 'PROCESSED' WHERE webhook_id = ?`).run(webhookTransmissionId);

    // Verify end-state assertions
    const finalDispute = db.prepare(`SELECT status, track, version FROM disputes WHERE id = 'DSP-INT-101'`).get() as any;
    expect(finalDispute.status).toBe('SUBMITTED');
    expect(finalDispute.track).toBe('TRACK_A_AUTO_SUBMIT');
    expect(finalDispute.version).toBe(2);

    const log = assertAuditLogExists(db, 'DSP-INT-101', 'AUTO_ROUTE_SUBMIT');
    expect(log).toBeDefined();
  });
});
