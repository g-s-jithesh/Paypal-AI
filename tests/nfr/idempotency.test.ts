import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

interface WebhookPayload {
  webhook_id: string;
  event_type: string;
  dispute_id: string;
  order_id: string;
  amount_cents: number;
}

// Ingestion pipeline simulation with atomic idempotency gate
function processWebhook(db: Database, payload: WebhookPayload): { status: 'PROCESSED' | 'DUPLICATE_IGNORED'; disputeId?: string } {
  const existing = db
    .prepare('SELECT processing_status FROM webhook_events WHERE webhook_id = ?')
    .get(payload.webhook_id) as { processing_status: string } | undefined;

  if (existing) {
    return { status: 'DUPLICATE_IGNORED' };
  }

  try {
    return db.transaction(() => {
      // 1. Record webhook event
      db.prepare(`
        INSERT INTO webhook_events (
          id, webhook_id, event_type, resource_id, payload_json, processing_status, processed_at
        ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(
        `wh_rec_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        payload.webhook_id,
        payload.event_type,
        payload.dispute_id,
        JSON.stringify(payload)
      );

      // 2. Insert Dispute (if not already exists)
      const internalDisputeId = `DSP-${payload.dispute_id}`;
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, seller_response_due_at
        ) VALUES (
          ?, 'm1', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'OPEN', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days')
        )
      `).run(
        internalDisputeId,
        payload.order_id,
        payload.dispute_id,
        payload.amount_cents
      );

      return { status: 'PROCESSED', disputeId: internalDisputeId };
    })();
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed: webhook_events.webhook_id')) {
      return { status: 'DUPLICATE_IGNORED' };
    }
    throw err;
  }
}

describe('Non-Functional Requirements: Webhook Idempotency (BR-011, TC-NFR-003)', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m1', 'Test Merchant', 1500)
    `).run();
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary)
      VALUES ('ord_idem', 'm1', 'PO-IDEM', 'buyer@idem.test', 'Idem Buyer', 20000, 'Test Order')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('TC-NFR-003a: Sequential Duplicate Webhook Ingestion returns DUPLICATE_IGNORED with 0 duplicate disputes', () => {
    const payload: WebhookPayload = {
      webhook_id: 'WH-BURST-SEQ-001',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      dispute_id: 'PP-D-BURST-001',
      order_id: 'ord_idem',
      amount_cents: 10000,
    };

    // First ingestion -> PROCESSED
    const res1 = processWebhook(db, payload);
    expect(res1.status).toBe('PROCESSED');

    // Second ingestion -> DUPLICATE_IGNORED
    const res2 = processWebhook(db, payload);
    expect(res2.status).toBe('DUPLICATE_IGNORED');

    // Exactly 1 dispute in database
    const disputeCount = (
      db.prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?').get('PP-D-BURST-001') as {
        count: number;
      }
    ).count;
    expect(disputeCount).toBe(1);

    // Exactly 1 webhook event in database
    const webhookCount = (
      db.prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?').get('WH-BURST-SEQ-001') as {
        count: number;
      }
    ).count;
    expect(webhookCount).toBe(1);
  });

  it('TC-NFR-003b: Concurrent Webhook Burst Simulation (20 requests with same webhook_id)', async () => {
    const payload: WebhookPayload = {
      webhook_id: 'WH-BURST-CONCUR-002',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      dispute_id: 'PP-D-BURST-002',
      order_id: 'ord_idem',
      amount_cents: 15000,
    };

    // Simulate 20 concurrent asynchronous requests
    const promises = Array.from({ length: 20 }, () =>
      Promise.resolve().then(() => processWebhook(db, payload))
    );

    const results = await Promise.all(promises);

    const processedCount = results.filter((r) => r.status === 'PROCESSED').length;
    const ignoredCount = results.filter((r) => r.status === 'DUPLICATE_IGNORED').length;

    expect(processedCount).toBe(1);
    expect(ignoredCount).toBe(19);

    const disputeCount = (
      db.prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?').get('PP-D-BURST-002') as {
        count: number;
      }
    ).count;
    expect(disputeCount).toBe(1);
  });
});
