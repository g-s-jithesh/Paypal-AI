import { getDb, initializeDatabase, closeDb } from '../lib/db';
import { computeSha256 } from './seed';

export function runScaleSeeder(totalDisputes: number = 5000): void {
  const db = getDb();
  initializeDatabase(db);

  console.log(`⚡ Launching Volumetric Scale Seeder (${totalDisputes} disputes)...`);
  const startTime = Date.now();

  const merchantId = 'merch_default';
  const BASE_TIMESTAMP = '2026-11-01T00:00:00.000Z';

  // Ensure default merchant and policies exist
  db.prepare(`
    INSERT OR IGNORE INTO merchants (id, name, paypal_mode, chargeback_fee_cents, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(merchantId, 'ChargebackShield Scale Test Store', 'SIMULATOR', 1500, 'USD', BASE_TIMESTAMP, BASE_TIMESTAMP);

  db.prepare(`
    INSERT OR IGNORE INTO policy_rules (
      id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
      min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
      default_ops_cost_cents, sla_buffer_hours, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('pol_default', merchantId, 25000, 0.40, 0.75, 3500, 0.35, 500, 4, 1, BASE_TIMESTAMP, BASE_TIMESTAMP);

  // Prepared insert statements
  const insertOrder = db.prepare(`
    INSERT OR REPLACE INTO orders (
      id, merchant_id, paypal_order_id, customer_email, customer_name,
      shipping_country, currency, amount_cents, carrier_name, tracking_number,
      delivery_status, item_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDispute = db.prepare(`
    INSERT OR REPLACE INTO disputes (
      id, merchant_id, order_id, paypal_dispute_id, reason_code,
      status, dispute_amount_cents, currency, seller_response_due_at,
      stage, track, version, submitted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvidence = db.prepare(`
    INSERT OR REPLACE INTO evidence_items (
      id, dispute_id, order_id, evidence_type, source_system,
      title, content_json, sha256_hash, is_verified, verified_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAssessment = db.prepare(`
    INSERT OR REPLACE INTO ai_assessments (
      id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
      recommended_action, confidence_score, reasoning_json, model_version,
      execution_latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (
      id, merchant_id, entity_type, entity_id, action,
      actor_id, actor_type, new_state_json, rule_ids_checked,
      guardrail_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const chunkSize = 500;
  const now = new Date(BASE_TIMESTAMP).getTime();
  const dayMs = 86400 * 1000;

  for (let batchStart = 1; batchStart <= totalDisputes; batchStart += chunkSize) {
    const batchEnd = Math.min(batchStart + chunkSize - 1, totalDisputes);

    db.transaction(() => {
      for (let i = batchStart; i <= batchEnd; i++) {
        const padId = `scale_${i}`;
        const orderId = `ORD-${padId}`;
        const disputeId = `DSP-${padId}`;
        const paypalOrderId = `O-${padId}`;
        const paypalDisputeId = `PP-D-${padId}`;

        // 45% INR, 25% SNAD, 20% UNAUTHORISED, 10% OTHER
        const mod100 = i % 100;
        let reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        if (mod100 >= 45 && mod100 < 70) reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        else if (mod100 >= 70 && mod100 < 90) reasonCode = 'UNAUTHORISED';
        else if (mod100 >= 90) reasonCode = 'OTHER';

        // Amounts: $25 to $600
        const amountCents = ((i * 17) % 575 + 25) * 100;
        const carrier = i % 2 === 0 ? 'UPS' : 'FedEx';
        const tracking = `1Z${String(i).padStart(16, '0')}`;
        const status = i % 5 === 0 ? 'WON' : i % 7 === 0 ? 'LOST' : i % 11 === 0 ? 'SETTLED_VIA_REFUND' : 'SUBMITTED';

        const createdTime = new Date(now - (i % 60) * dayMs).toISOString();
        const dueTime = new Date(new Date(createdTime).getTime() + 10 * dayMs).toISOString();
        const submittedTime = new Date(new Date(createdTime).getTime() + 9200).toISOString();

        // 1. Order
        insertOrder.run(
          orderId, merchantId, paypalOrderId, `buyer_${i}@scale.test`, `Buyer ${i}`,
          'US', 'USD', amountCents, carrier, tracking, 'DELIVERED', `Scale Item ${i}`,
          createdTime, createdTime
        );

        // 2. Dispute
        insertDispute.run(
          disputeId, merchantId, orderId, paypalDisputeId, reasonCode,
          status, amountCents, 'USD', dueTime, 'CHARGEBACK', 'TRACK_A_AUTO_SUBMIT',
          1, submittedTime, createdTime, createdTime
        );

        // 3. Evidence Items (3 items per dispute)
        for (let e = 1; e <= 3; e++) {
          const content = JSON.stringify({ tracking, carrier, itemIndex: e });
          insertEvidence.run(
            `evi_${padId}_${e}`, disputeId, orderId, 'TRACKING_PROOF', `SYSTEM_${carrier}`,
            `Carrier Checkpoint ${e}`, content, computeSha256(content), 1, createdTime, createdTime
          );
        }

        // 4. AI Assessment
        insertAssessment.run(
          `asmt_${padId}`, disputeId, 0.82, Math.round(amountCents * 0.80),
          Math.round(amountCents * 0.60), 'AUTO_SUBMIT_EVIDENCE', 0.94,
          '{}', 'scale-engine-v1', 12, createdTime
        );

        // 5. Audit Log
        insertAudit.run(
          `aud_${padId}`, merchantId, 'disputes', disputeId, `MUTATION_${status}`,
          'ACT-04', 'AI_AGENT', JSON.stringify({ status }), '["BR-001","BR-016"]',
          'PASSED', createdTime
        );
      }
    })();

    process.stdout.write(`\r  • Inserted ${batchEnd} / ${totalDisputes} records...`);
  }

  const duration = Date.now() - startTime;
  console.log(`\n✅ Scale dataset generated in ${duration} ms (${(totalDisputes / (duration / 1000)).toFixed(0)} disputes/sec)`);

  // TC-NFR-007: Benchmark C-Suite Query Latency
  console.log('⏱️ Benchmarking C-Suite KPI Query Latency under Volume:');
  const benchStart = performance.now();
  const kpiRow = db.prepare(`
    SELECT 
      COUNT(*) AS total_disputes,
      ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct,
      ROUND(SUM(CASE WHEN status = 'WON' THEN dispute_amount_cents ELSE 0 END) / 100.0, 2) AS total_won_dollars
    FROM disputes
    WHERE merchant_id = 'merch_default';
  `).get() as { total_disputes: number; win_rate_pct: number; total_won_dollars: number };
  const queryDuration = performance.now() - benchStart;

  console.log(`  • Disputes Count: ${kpiRow.total_disputes}`);
  console.log(`  • Win Rate: ${kpiRow.win_rate_pct}%`);
  console.log(`  • Revenue Saved: $${kpiRow.total_won_dollars.toLocaleString()}`);
  console.log(`  • Execution Latency: ${queryDuration.toFixed(2)} ms (Threshold < 50.0 ms)`);

  if (queryDuration < 50.0) {
    console.log('  🎯 TC-NFR-007 PASSED: Query latency is well within the 50ms performance target.');
  } else {
    console.warn('  ⚠️ TC-NFR-007 WARNING: Query latency exceeded 50ms threshold.');
  }

  closeDb();
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('seed-scale.ts') || 
  process.argv[1].endsWith('seed-scale') ||
  process.argv[1].includes('seed-scale.ts')
);

if (isDirectRun || (typeof require !== 'undefined' && require.main === module)) {
  runScaleSeeder();
}
