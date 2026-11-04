import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import DatabaseConstructor, { Database } from 'better-sqlite3';
import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';

interface WebhookPayload {
  webhook_id: string;
  event_type: string;
  dispute_id: string;
  order_id: string;
  amount_cents: number;
}

// Function executing webhook ingestion with atomic transaction and idempotency gate
function ingestWebhook(db: Database, payload: WebhookPayload): { status: 'PROCESSED' | 'DUPLICATE_IGNORED'; disputeId?: string } {
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
        `wh_evt_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        payload.webhook_id,
        payload.event_type,
        payload.dispute_id,
        JSON.stringify(payload)
      );

      // 2. Insert Dispute record
      const internalDisputeId = `DSP-${payload.dispute_id}`;
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, seller_response_due_at
        ) VALUES (
          ?, 'm_race', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          'OPEN', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days')
        )
      `).run(
        internalDisputeId,
        payload.order_id,
        payload.dispute_id,
        payload.amount_cents
      );

      return { status: 'PROCESSED' as const, disputeId: internalDisputeId };
    })();
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed: webhook_events.webhook_id')) {
      return { status: 'DUPLICATE_IGNORED' };
    }
    throw err;
  }
}

describe('Tier 5 Adversarial: SQLite WAL Mode Locking & Concurrency Stress', () => {
  const testDbDir = path.resolve(process.cwd(), 'tests', 'adversarial', 'fixtures');
  const diskDbPath = path.join(testDbDir, 'wal_concurrency_stress.db');
  let masterDb: Database;

  beforeAll(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    // Clean up prior test artifacts if present
    for (const ext of ['', '-wal', '-shm']) {
      const p = `${diskDbPath}${ext}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    masterDb = new DatabaseConstructor(diskDbPath, { timeout: 10000 });
    masterDb.pragma('journal_mode = WAL');
    masterDb.pragma('synchronous = NORMAL');
    masterDb.pragma('busy_timeout = 10000');
    masterDb.pragma('foreign_keys = ON');

    // Initialize full schema
    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'db', 'schema.sql'), 'utf8');
    masterDb.exec(schemaSql);

    // Seed master merchant and orders for stress tests
    masterDb.prepare(`
      INSERT INTO merchants (id, name, chargeback_fee_cents)
      VALUES ('m_race', 'Race Condition Merchant', 1500)
    `).run();

    masterDb.prepare(`
      INSERT INTO orders (
        id, merchant_id, paypal_order_id, customer_email, customer_name,
        amount_cents, item_summary
      ) VALUES (
        'ord_race_master', 'm_race', 'PO-RACE-001', 'stress@test.com', 'Stress Customer',
        50000, 'Stress Test Item'
      )
    `).run();
  });

  afterAll(() => {
    masterDb.close();
    // Cleanup temporary fixture db files
    for (const ext of ['', '-wal', '-shm']) {
      const p = `${diskDbPath}${ext}`;
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {}
      }
    }
  });

  it('Stress 1: High-burst async promises (50 parallel attempts with identical webhook_id)', async () => {
    const payload: WebhookPayload = {
      webhook_id: 'WH-BURST-STRESS-001',
      event_type: 'CUSTOMER.DISPUTE.CREATED',
      dispute_id: 'PP-D-BURST-STRESS-001',
      order_id: 'ord_race_master',
      amount_cents: 12000,
    };

    // Rapidly fire 50 parallel requests
    const tasks = Array.from({ length: 50 }, () =>
      new Promise<{ status: string }>((resolve) => {
        setImmediate(() => {
          const res = ingestWebhook(masterDb, payload);
          resolve(res);
        });
      })
    );

    const results = await Promise.all(tasks);

    const processedCount = results.filter((r) => r.status === 'PROCESSED').length;
    const ignoredCount = results.filter((r) => r.status === 'DUPLICATE_IGNORED').length;

    expect(processedCount).toBe(1);
    expect(ignoredCount).toBe(49);

    // Assert exact single dispute and single webhook recorded
    const disputes = masterDb
      .prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?')
      .get(payload.dispute_id) as { count: number };
    expect(disputes.count).toBe(1);

    const webhooks = masterDb
      .prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?')
      .get(payload.webhook_id) as { count: number };
    expect(webhooks.count).toBe(1);
  });

  it('Stress 2: Multi-threaded worker contention (10 OS threads firing duplicate webhook_id concurrently to disk SQLite)', async () => {
    const duplicateWebhookId = 'WH-THREAD-DUP-999';
    const disputeId = 'PP-D-THREAD-DUP-999';

    // Worker code that opens its own connection to disk SQLite in WAL mode
    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const Database = require('better-sqlite3');

      const db = new Database(workerData.dbPath, { timeout: 15000 });
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 15000');
      db.pragma('foreign_keys = ON');

      const payload = workerData.payload;

      function ingest(payload) {
        const existing = db
          .prepare('SELECT processing_status FROM webhook_events WHERE webhook_id = ?')
          .get(payload.webhook_id);

        if (existing) {
          return { status: 'DUPLICATE_IGNORED' };
        }

        try {
          return db.transaction(() => {
            db.prepare(\`
              INSERT INTO webhook_events (
                id, webhook_id, event_type, resource_id, payload_json, processing_status, processed_at
              ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            \`).run(
              'wh_' + Date.now() + '_' + Math.random().toString(36).substring(7),
              payload.webhook_id,
              payload.event_type,
              payload.dispute_id,
              JSON.stringify(payload)
            );

            const internalDisputeId = 'DSP-' + payload.dispute_id;
            db.prepare(\`
              INSERT INTO disputes (
                id, merchant_id, order_id, paypal_dispute_id, reason_code,
                status, dispute_amount_cents, seller_response_due_at
              ) VALUES (
                ?, 'm_race', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
                'OPEN', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days')
              )
            \`).run(
              internalDisputeId,
              payload.order_id,
              payload.dispute_id,
              payload.amount_cents
            );

            return { status: 'PROCESSED' as const, disputeId: internalDisputeId };
          })();
        } catch (err) {
          if (err.message.includes('UNIQUE constraint failed: webhook_events.webhook_id')) {
            return { status: 'DUPLICATE_IGNORED' };
          }
          throw err;
        } finally {
          db.close();
        }
      }

      try {
        const result = ingest(payload);
        parentPort.postMessage({ success: true, result });
      } catch (err) {
        parentPort.postMessage({ success: false, error: err.message });
      }
    `;

    const numThreads = 10;
    const workerPromises = Array.from({ length: numThreads }, (_, idx) => {
      return new Promise<{ success: boolean; result?: { status: string }; error?: string }>((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: {
            dbPath: diskDbPath,
            payload: {
              webhook_id: duplicateWebhookId,
              event_type: 'CUSTOMER.DISPUTE.CREATED',
              dispute_id: disputeId,
              order_id: 'ord_race_master',
              amount_cents: 15000,
            },
          },
        });

        worker.on('message', (msg) => resolve(msg));
        worker.on('error', (err) => reject(err));
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
      });
    });

    const threadResults = await Promise.all(workerPromises);

    // All threads must execute cleanly without crashing
    for (const res of threadResults) {
      expect(res.success).toBe(true);
    }

    const processed = threadResults.filter((r) => r.result?.status === 'PROCESSED').length;
    const duplicates = threadResults.filter((r) => r.result?.status === 'DUPLICATE_IGNORED').length;

    // Exactly 1 thread succeeds in inserting, remaining 9 receive DUPLICATE_IGNORED
    expect(processed).toBe(1);
    expect(duplicates).toBe(numThreads - 1);

    // Check DB state
    const dCount = (
      masterDb.prepare('SELECT count(*) as count FROM disputes WHERE paypal_dispute_id = ?').get(disputeId) as {
        count: number;
      }
    ).count;
    expect(dCount).toBe(1);

    const wCount = (
      masterDb.prepare('SELECT count(*) as count FROM webhook_events WHERE webhook_id = ?').get(duplicateWebhookId) as {
        count: number;
      }
    ).count;
    expect(wCount).toBe(1);
  });

  it('Stress 3: Multi-threaded parallel distinct writes (10 OS threads writing different disputes to disk SQLite)', async () => {
    // Seed 10 distinct orders
    for (let i = 1; i <= 10; i++) {
      masterDb.prepare(`
        INSERT INTO orders (
          id, merchant_id, paypal_order_id, customer_email, customer_name,
          amount_cents, item_summary
        ) VALUES (
          ?, 'm_race', ?, 'cust@example.com', 'Cust', 20000, 'Order Item'
        )
      `).run(`ord_dist_${i}`, `PO-DIST-${i}`);
    }

    const workerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const Database = require('better-sqlite3');

      const db = new Database(workerData.dbPath, { timeout: 15000 });
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 15000');
      db.pragma('foreign_keys = ON');

      const payload = workerData.payload;

      try {
        const result = db.transaction(() => {
          db.prepare(\`
            INSERT INTO webhook_events (
              id, webhook_id, event_type, resource_id, payload_json, processing_status, processed_at
            ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          \`).run(
            'wh_' + Date.now() + '_' + Math.random().toString(36).substring(7),
            payload.webhook_id,
            payload.event_type,
            payload.dispute_id,
            JSON.stringify(payload)
          );

          const internalDisputeId = 'DSP-' + payload.dispute_id;
          db.prepare(\`
            INSERT INTO disputes (
              id, merchant_id, order_id, paypal_dispute_id, reason_code,
              status, dispute_amount_cents, seller_response_due_at
            ) VALUES (
              ?, 'm_race', ?, ?, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
              'OPEN', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 days')
            )
          \`).run(
            internalDisputeId,
            payload.order_id,
            payload.dispute_id,
            payload.amount_cents
          );

          return { status: 'PROCESSED' as const, disputeId: internalDisputeId };
        })();

        db.close();
        parentPort.postMessage({ success: true, result });
      } catch (err) {
        try { db.close(); } catch {}
        parentPort.postMessage({ success: false, error: err.message });
      }
    `;

    const numThreads = 10;
    const workerPromises = Array.from({ length: numThreads }, (_, idx) => {
      const threadIndex = idx + 1;
      return new Promise<{ success: boolean; result?: { status: string }; error?: string }>((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: {
            dbPath: diskDbPath,
            payload: {
              webhook_id: `WH-DISTINCT-THREAD-${threadIndex}`,
              event_type: 'CUSTOMER.DISPUTE.CREATED',
              dispute_id: `PP-D-DISTINCT-THREAD-${threadIndex}`,
              order_id: `ord_dist_${threadIndex}`,
              amount_cents: 10000 + threadIndex,
            },
          },
        });

        worker.on('message', (msg) => resolve(msg));
        worker.on('error', (err) => reject(err));
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
      });
    });

    const threadResults = await Promise.all(workerPromises);

    for (const res of threadResults) {
      expect(res.success).toBe(true);
      expect(res.result?.status).toBe('PROCESSED');
    }

    // Verify all 10 disputes and webhooks exist in the database
    const disputesCount = (
      masterDb.prepare("SELECT count(*) as count FROM disputes WHERE paypal_dispute_id LIKE 'PP-D-DISTINCT-THREAD-%'").get() as {
        count: number;
      }
    ).count;
    expect(disputesCount).toBe(10);

    const webhooksCount = (
      masterDb.prepare("SELECT count(*) as count FROM webhook_events WHERE webhook_id LIKE 'WH-DISTINCT-THREAD-%'").get() as {
        count: number;
      }
    ).count;
    expect(webhooksCount).toBe(10);
  });

  it('Database Integrity: PRAGMA integrity_check passes with ok', () => {
    const check = masterDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string };
    expect(check.integrity_check).toBe('ok');
  });
});
