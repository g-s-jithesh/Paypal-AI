/**
 * ChargebackShield — Tier 2 Boundary & Corner Cases: Lifecycle & State Transitions
 * Covers illegal state jumps, expired SLA limits, duplicate webhook bursts, and concurrency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, SqliteDbAdapter, seedBaselineMerchant } from '../helpers/db-helper';

describe('Tier 2: Lifecycle & State Transition Boundaries', () => {
  let db: SqliteDbAdapter;

  beforeEach(() => {
    db = createTestDb(':memory:');
    seedBaselineMerchant(db);

    // Setup base order and dispute
    db.prepare(`
      INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, currency, amount_cents, delivery_status, item_summary)
      VALUES ('ORD-LIFE-1', 'merch_default', 'O-LIFE-1', 'life@test.com', 'Life Tester', 'USD', 10000, 'DELIVERED', 'Camera')
    `).run();

    db.prepare(`
      INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, stage, version)
      VALUES ('DSP-LIFE-1', 'merch_default', 'ORD-LIFE-1', 'PP-LIFE-1', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 10000, 'USD', '2026-12-01T00:00:00Z', 'INQUIRY', 1)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('T2-LIFE-1: Illegal transition from WON to NEGOTIATING is blocked by BR-005 trigger', () => {
    db.prepare(`UPDATE disputes SET status = 'WON' WHERE id = 'DSP-LIFE-1'`).run();

    expect(() => {
      db.prepare(`UPDATE disputes SET status = 'NEGOTIATING' WHERE id = 'DSP-LIFE-1'`).run();
    }).toThrow(/BR-005/);
  });

  it('T2-LIFE-2: Illegal transition from LOST to SUBMITTED is blocked by BR-005 trigger', () => {
    db.prepare(`UPDATE disputes SET status = 'LOST' WHERE id = 'DSP-LIFE-1'`).run();

    expect(() => {
      db.prepare(`UPDATE disputes SET status = 'SUBMITTED' WHERE id = 'DSP-LIFE-1'`).run();
    }).toThrow(/BR-005/);
  });

  it('T2-LIFE-3: Illegal transition from EXPIRED to SUBMITTED is blocked by BR-005 trigger', () => {
    db.prepare(`UPDATE disputes SET status = 'EXPIRED' WHERE id = 'DSP-LIFE-1'`).run();

    expect(() => {
      db.prepare(`UPDATE disputes SET status = 'SUBMITTED' WHERE id = 'DSP-LIFE-1'`).run();
    }).toThrow(/BR-005/);
  });

  it('T2-LIFE-4: Illegal transition from SETTLED_VIA_REFUND to SUBMITTED is blocked by BR-005 trigger', () => {
    db.prepare(`UPDATE disputes SET status = 'SETTLED_VIA_REFUND' WHERE id = 'DSP-LIFE-1'`).run();

    expect(() => {
      db.prepare(`UPDATE disputes SET status = 'SUBMITTED' WHERE id = 'DSP-LIFE-1'`).run();
    }).toThrow(/BR-005/);
  });

  it('T2-LIFE-5: Past SLA expiration deadline is rejected by check constraint on insert', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, currency, seller_response_due_at, created_at, stage, version)
        VALUES ('DSP-PAST-SLA', 'merch_default', 'ORD-LIFE-1', 'PP-PAST', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'OPEN', 5000, 'USD', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'INQUIRY', 1)
      `).run();
    }).toThrow();
  });

  it('T2-LIFE-6: Webhook burst idempotency: 10 identical webhook calls insert exactly 1 record', () => {
    const burstWebhookId = 'WH-BURST-100';

    // First delivery succeeds
    db.prepare(`
      INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
      VALUES ('WH-BURST-ROW-1', ?, 'CUSTOMER.DISPUTE.CREATED', 'PP-D-BURST', '{}', 'PROCESSED')
    `).run(burstWebhookId);

    // Remaining 9 deliveries are caught and treated as duplicate ignored
    let duplicateRejectedCount = 0;
    for (let i = 2; i <= 10; i++) {
      try {
        db.prepare(`
          INSERT INTO webhook_events (id, webhook_id, event_type, resource_id, payload_json, processing_status)
          VALUES (?, ?, 'CUSTOMER.DISPUTE.CREATED', 'PP-D-BURST', '{}', 'PROCESSED')
        `).run(`WH-BURST-ROW-${i}`, burstWebhookId);
      } catch (e) {
        duplicateRejectedCount++;
      }
    }

    expect(duplicateRejectedCount).toBe(9);
    const totalCount = (db.prepare(`SELECT COUNT(*) as c FROM webhook_events WHERE webhook_id = ?`).get(burstWebhookId) as any).c;
    expect(totalCount).toBe(1);
  });

  it('T2-LIFE-7: Stale version optimistic locking conflict check', () => {
    const currentVersion = (db.prepare(`SELECT version FROM disputes WHERE id = 'DSP-LIFE-1'`).get() as any).version;

    // Simulate concurrent modification where another worker updated version to 2
    db.prepare(`UPDATE disputes SET version = 2 WHERE id = 'DSP-LIFE-1'`).run();

    // Stale worker attempting update with version 1
    const result = db.prepare(`
      UPDATE disputes SET status = 'SUBMITTED', version = version + 1
      WHERE id = 'DSP-LIFE-1' AND version = ?
    `).run(currentVersion);

    // Expect 0 rows updated due to version mismatch
    expect(result.changes).toBe(0);
  });
});
