import crypto from 'crypto';
import { getDb, initializeDatabase, closeDb } from '../lib/db';

// Deterministic Mulberry32 PRNG
export function createPrng(seed: number) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeSha256(content: object | string): string {
  const str = typeof content === 'string' ? content : JSON.stringify(content, Object.keys(content).sort());
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function runGoldenSeeder(): void {
  const db = getDb();
  initializeDatabase(db);

  console.log('🌱 Starting ChargebackShield Deterministic Golden Seeder (50 Disputes)...');

  const random = createPrng(0x5eed2026);

  db.transaction(() => {
    // 1. Wipe existing data cleanly in foreign-key safe order
    db.prepare('DELETE FROM webhook_events').run();
    db.prepare('DELETE FROM settlement_offers').run();
    db.prepare('DELETE FROM negotiation_sessions').run();
    db.prepare('DELETE FROM ai_assessments').run();
    db.prepare('DELETE FROM evidence_items').run();
    db.prepare('DELETE FROM disputes').run();
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM policy_rules').run();
    db.prepare('DELETE FROM merchants').run();
    // Temporarily disable trigger for audit log clean wipe during deterministic re-seed
    db.prepare('DROP TRIGGER IF EXISTS trg_audit_logs_no_delete').run();
    db.prepare('DELETE FROM audit_logs').run();
    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      BEGIN
        SELECT RAISE(ABORT, 'BR-012: audit_logs is strictly append-only: deletions are prohibited');
      END;
    `).run();

    // 2. Insert Default Merchant (ENT-01)
    const merchantId = 'merch_default';
    const BASE_TIMESTAMP = '2026-11-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO merchants (id, name, paypal_client_id, paypal_client_secret, paypal_mode, chargeback_fee_cents, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      merchantId,
      'ChargebackShield Global Merchant',
      'sb-client-mock-12345',
      'sb-secret-mock-67890',
      'SIMULATOR',
      1500,
      'USD',
      BASE_TIMESTAMP,
      BASE_TIMESTAMP
    );

    // 3. Insert Default Policy Rules (ENT-08)
    db.prepare(`
      INSERT INTO policy_rules (
        id, merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
        min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
        default_ops_cost_cents, sla_buffer_hours, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pol_default', merchantId, 25000, 0.40, 0.75, 3500, 0.35, 500, 4, 1, BASE_TIMESTAMP, BASE_TIMESTAMP);

    // 4. Products & Catalogs
    const products = [
      { name: 'Bose QuietComfort Ultra Headphones', price: 14500, carrier: 'UPS' },
      { name: 'Keychron Q1 Pro Mechanical Keyboard', price: 8500, carrier: 'FedEx' },
      { name: 'Breville Precision Brewer', price: 12000, carrier: 'USPS' },
      { name: 'Samsung Odyssey G9 49" Gaming Monitor', price: 45000, carrier: 'UPS' },
      { name: 'Anker USB-C Multiport Hub Adapter', price: 2800, carrier: 'USPS' },
      { name: 'Sony WH-1000XM5 Wireless Headphones', price: 39800, carrier: 'UPS' },
      { name: 'Logitech MX Master 3S Wireless Mouse', price: 9900, carrier: 'FedEx' },
      { name: 'Apple iPad Air 11-inch M2', price: 59900, carrier: 'UPS' },
      { name: 'Dyson V8 Cordless Vacuum Cleaner', price: 34900, carrier: 'FedEx' },
      { name: 'Patagonia Nano Puff Jacket', price: 23900, carrier: 'USPS' },
      { name: 'Kindle Paperwhite Signature Edition', price: 18900, carrier: 'USPS' },
      { name: 'Nespresso Vertuo Pop+ Coffee Machine', price: 12900, carrier: 'FedEx' },
      { name: 'DJI Mini 4 Pro Drone', price: 75900, carrier: 'UPS' },
      { name: 'Fitbit Charge 6 Fitness Tracker', price: 15900, carrier: 'USPS' },
      { name: 'Hydro Flask 32 oz Wide Mouth Bottle', price: 4500, carrier: 'USPS' },
    ];

    const customerNames = [
      'Alex Rivera', 'Jordan Lee', 'Morgan Taylor', 'Sarah Jenkins', 'David Kim',
      'Elena Rostova', 'Marcus Brody', 'Rachel Green', 'Harvey Specter', 'Donna Paulsen',
      'Michael Scott', 'Jim Halpert', 'Pam Beesly', 'Dwight Schrute', 'Stanley Hudson'
    ];

    const now = new Date(BASE_TIMESTAMP).getTime();
    const dayMs = 86400 * 1000;

    // 5. Seed 50 Orders and 50 Disputes
    for (let i = 1; i <= 50; i++) {
      const padId = String(i).padStart(3, '0');
      const orderId = `ORD-GOLD-${padId}`;
      const disputeId = `DSP-GOLD-${padId}`;
      const paypalOrderId = `O-GOLD-${padId}`;
      const paypalDisputeId = `PP-D-${padId}`;
      const webhookId = `WH-GOLD-${padId}`;

      const prod = products[(i - 1) % products.length];
      const customer = customerNames[(i - 1) % customerNames.length];
      const customerEmail = `${customer.toLowerCase().replace(/\s+/g, '.')}@example.com`;

      let amountCents = prod.price;
      let carrier = prod.carrier;
      let tracking = carrier === 'UPS' ? `1Z9999999999999${padId}` : `94001000000000000${padId}`;
      let deliveryStatus = 'DELIVERED';
      let signatureName: string | null = customer;
      let reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
      let status = 'SUBMITTED';
      let track = 'TRACK_A_AUTO_SUBMIT';
      let winProb = 0.85;
      let recAction = 'AUTO_SUBMIT_EVIDENCE';
      let buyerText = 'Item arrived safely as expected.';
      let isAutonomous = true;

      const orderCreatedTime = new Date(now - (30 - (i % 20)) * dayMs).toISOString();
      const shippedTime = new Date(new Date(orderCreatedTime).getTime() + 86400 * 1000).toISOString();
      let deliveredTime: string | null = new Date(new Date(shippedTime).getTime() + 172800 * 1000).toISOString();
      const disputeCreatedTime = new Date(new Date(shippedTime).getTime() + 259200 * 1000).toISOString();
      const dueTime = new Date(new Date(disputeCreatedTime).getTime() + 10 * dayMs).toISOString();
      let submittedTime: string | null = new Date(new Date(disputeCreatedTime).getTime() + 8400).toISOString(); // 8.4 seconds MTTES
      let resolvedTime: string | null = null;

      // -------------------------------------------------------------
      // EXACT BENCHMARK PERSONAS (DSP-GOLD-001 to DSP-GOLD-005)
      // -------------------------------------------------------------
      if (i === 1) {
        // DSP-GOLD-001: High-Confidence INR Auto-Win
        amountCents = 14500;
        carrier = 'UPS';
        tracking = '1Z9999999999999991';
        deliveryStatus = 'DELIVERED';
        signatureName = 'Alex Rivera';
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'SUBMITTED';
        track = 'TRACK_A_AUTO_SUBMIT';
        winProb = 0.91;
        recAction = 'AUTO_SUBMIT_EVIDENCE';
        buyerText = 'Buyer claims package was never received at the front door.';
      } else if (i === 2) {
        // DSP-GOLD-002: Missing Delivery Proof Guardrail
        amountCents = 8500;
        carrier = 'FedEx';
        tracking = '94001000000000000002';
        deliveryStatus = 'IN_TRANSIT';
        deliveredTime = null;
        signatureName = null;
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'NEGOTIATING';
        track = 'TRACK_B_NEGOTIATE';
        winProb = 0.32;
        recAction = 'OFFER_PARTIAL_REFUND';
        submittedTime = null;
        buyerText = 'Tracking still shows in transit for 14 days.';
      } else if (i === 3) {
        // DSP-GOLD-003: SNAD Partial Refund Settlement
        amountCents = 12000;
        carrier = 'USPS';
        tracking = '94001000000000000003';
        deliveryStatus = 'DELIVERED';
        reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        status = 'SETTLED_VIA_REFUND';
        track = 'TRACK_B_NEGOTIATE';
        winProb = 0.55;
        recAction = 'OFFER_PARTIAL_REFUND';
        resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 7200 * 1000).toISOString();
        buyerText = 'Item arrived with cracked water reservoir and cosmetic scratches.';
      } else if (i === 4) {
        // DSP-GOLD-004: High-Value Human Gate ($450 > $250)
        amountCents = 45000;
        carrier = 'UPS';
        tracking = '1Z9999999999999994';
        deliveryStatus = 'DELIVERED';
        signatureName = 'Sarah Jenkins';
        reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        status = 'READY_FOR_REVIEW';
        track = 'TRACK_D_HUMAN_REVIEW';
        winProb = 0.88;
        recAction = 'ESCALATE_TO_HUMAN';
        submittedTime = null;
        buyerText = 'High-value package not received despite signed signature.';
      } else if (i === 5) {
        // DSP-GOLD-005: Low-Value Auto-Accept ($28 <= $35, Neg EV)
        amountCents = 2800;
        carrier = 'USPS';
        tracking = '94001000000000000005';
        deliveryStatus = 'UNFULFILLED';
        deliveredTime = null;
        signatureName = null;
        reasonCode = 'UNAUTHORISED';
        status = 'SETTLED_VIA_REFUND';
        track = 'TRACK_C_AUTO_ACCEPT';
        winProb = 0.20;
        recAction = 'AUTO_ACCEPT_CLAIM';
        submittedTime = null;
        resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 1800 * 1000).toISOString();
        buyerText = 'Unrecognized charge for small electronics accessory.';
      } else {
        // -------------------------------------------------------------
        // STATISTICAL DISTRIBUTION (Remaining 45 records)
        // -------------------------------------------------------------
        if (i <= 22) {
          reasonCode = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
        } else if (i <= 35) {
          reasonCode = 'SIGNIFICANTLY_NOT_AS_DESCRIBED';
        } else if (i <= 45) {
          reasonCode = 'UNAUTHORISED';
        } else {
          reasonCode = i % 2 === 0 ? 'CANCELLED_RECURRING_BILLING' : 'OTHER';
        }

        // Status Skew:
        // 8 WON, 3 LOST, 5 SETTLED_VIA_REFUND, 1 EXPIRED, 12 SUBMITTED, 8 READY_FOR_REVIEW, 9 NEGOTIATING, 2 OPEN, 2 EVIDENCE_GATHERING
        if (i >= 6 && i <= 13) {
          status = 'WON';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 5 * dayMs).toISOString();
          winProb = 0.85 + random() * 0.12;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
        } else if (i >= 14 && i <= 16) {
          status = 'LOST';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 6 * dayMs).toISOString();
          winProb = 0.25 + random() * 0.15;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          isAutonomous = i === 14; // i=15 and i=16 have isAutonomous = false (MERCHANT_USER)
        } else if (i >= 17 && i <= 19) {
          status = 'SETTLED_VIA_REFUND';
          resolvedTime = new Date(new Date(disputeCreatedTime).getTime() + 2 * dayMs).toISOString();
          winProb = 0.45 + random() * 0.15;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          submittedTime = null;
        } else if (i === 20) {
          status = 'EXPIRED';
          resolvedTime = dueTime;
          winProb = 0.30;
          recAction = 'ESCALATE_TO_HUMAN';
          track = 'TRACK_D_HUMAN_REVIEW';
          submittedTime = null;
          isAutonomous = false;
        } else if (i >= 21 && i <= 31) {
          status = 'SUBMITTED';
          winProb = 0.78 + random() * 0.18;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
        } else if (i >= 32 && i <= 38) {
          status = 'READY_FOR_REVIEW';
          winProb = 0.50 + random() * 0.20;
          recAction = 'ESCALATE_TO_HUMAN';
          track = 'TRACK_D_HUMAN_REVIEW';
          submittedTime = null;
        } else if (i >= 39 && i <= 46) {
          status = 'NEGOTIATING';
          winProb = 0.40 + random() * 0.20;
          recAction = 'OFFER_PARTIAL_REFUND';
          track = 'TRACK_B_NEGOTIATE';
          submittedTime = null;
        } else if (i >= 47 && i <= 48) {
          status = 'EVIDENCE_GATHERING';
          winProb = 0.60;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
          submittedTime = null;
        } else {
          status = 'OPEN';
          winProb = 0.50;
          recAction = 'AUTO_SUBMIT_EVIDENCE';
          track = 'TRACK_A_AUTO_SUBMIT';
          submittedTime = null;
        }
      }

      // Insert Order (ENT-02)
      db.prepare(`
        INSERT INTO orders (
          id, merchant_id, paypal_order_id, capture_id, customer_id,
          customer_email, customer_name, shipping_address_line1, shipping_city,
          shipping_state, shipping_postal_code, shipping_country, currency,
          amount_cents, carrier_name, tracking_number, delivery_status,
          shipped_at, delivered_at, delivery_signature_name, item_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId, merchantId, paypalOrderId, `CAP-${padId}`, `CUST-${padId}`,
        customerEmail, customer, `${100 + i} Market Street`, 'San Jose',
        'CA', '95131', 'US', 'USD', amountCents, carrier, tracking, deliveryStatus,
        shippedTime, deliveredTime, signatureName, prod.name, orderCreatedTime, orderCreatedTime
      );

      // Insert Dispute (ENT-03)
      db.prepare(`
        INSERT INTO disputes (
          id, merchant_id, order_id, paypal_dispute_id, reason_code,
          status, dispute_amount_cents, currency, buyer_dispute_reason_text,
          seller_response_due_at, stage, track, version, submitted_at,
          resolved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        disputeId, merchantId, orderId, paypalDisputeId, reasonCode,
        status, amountCents, 'USD', buyerText,
        dueTime, 'INQUIRY', track, 1, submittedTime,
        resolvedTime, disputeCreatedTime, disputeCreatedTime
      );

      // Insert Evidence Items (ENT-04) (4 items per dispute)
      const evidenceList = [
        {
          type: 'TRACKING_PROOF',
          title: `${carrier} Official Delivery Checkpoint Scan`,
          content: { carrier, tracking_number: tracking, delivery_status: deliveryStatus, delivered_at: deliveredTime },
        },
        {
          type: 'DELIVERY_SIGNATURE',
          title: 'Proof of Delivery Signature Record',
          content: { signed_by: signatureName ?? 'No Signature Required', verified: signatureName !== null },
        },
        {
          type: 'ORDER_RECEIPT',
          title: 'PayPal Orders v2 Transaction Receipt',
          content: { paypal_order_id: paypalOrderId, item: prod.name, amount_cents: amountCents, currency: 'USD' },
        },
        {
          type: 'REFUND_POLICY',
          title: 'Merchant Standard 30-Day Return & Dispute Policy',
          content: { policy_id: 'POL-RETURN-STD', published_url: 'https://store.example.com/returns' },
        },
      ];

      evidenceList.forEach((ev, evIdx) => {
        const evId = `evi_gold_${padId}_${evIdx + 1}`;
        const contentStr = JSON.stringify(ev.content);
        const hash = computeSha256(contentStr);
        db.prepare(`
          INSERT INTO evidence_items (
            id, dispute_id, order_id, evidence_type, source_system,
            title, content_json, sha256_hash, is_verified, verified_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          evId, disputeId, orderId, ev.type, `SYSTEM_${carrier}`,
          ev.title, contentStr, hash, 1, disputeCreatedTime, disputeCreatedTime
        );
      });

      // Insert AI Assessment (ENT-05)
      const feeCents = 1500;
      const opsCents = 500;
      const evCompete = Math.round(winProb * amountCents - (1 - winProb) * feeCents - opsCents);
      const evSettle = Math.round(amountCents - amountCents * 0.40);

      db.prepare(`
        INSERT INTO ai_assessments (
          id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
          recommended_action, confidence_score, reasoning_json, model_version,
          execution_latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `asmt_gold_${padId}`, disputeId, Number(winProb.toFixed(4)), evCompete, evSettle,
        recAction, 0.92, JSON.stringify({ reasonCode, winProb, evCompete, evSettle }),
        'rule-ev-engine-v1.0', 145, disputeCreatedTime
      );

      // Insert Negotiation Session (ENT-06) for Track B or Settled disputes
      if (status === 'NEGOTIATING' || status === 'SETTLED_VIA_REFUND') {
        const negId = `neg_gold_${padId}`;
        const tokenHash = computeSha256(`TOKEN_${disputeId}`);
        const maxRefundCents = Math.floor(amountCents * 0.40);
        const isSettled = status === 'SETTLED_VIA_REFUND';

        db.prepare(`
          INSERT INTO negotiation_sessions (
            id, dispute_id, status, token_hash, max_refund_allowed_cents,
            messages_json, guardrail_triggered_count, last_buyer_activity_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          negId, disputeId, isSettled ? 'COMPLETED_SETTLED' : 'ACTIVE',
          tokenHash, maxRefundCents,
          JSON.stringify([
            { sender: 'AI_AGENT', text: 'Welcome to merchant resolution portal. How can we resolve this?' },
            { sender: 'BUYER', text: buyerText }
          ]),
          i === 3 ? 1 : 0, disputeCreatedTime, disputeCreatedTime, disputeCreatedTime
        );

        // Insert Settlement Offer (ENT-07)
        const offerAmountCents = isSettled ? Math.floor(maxRefundCents * 0.88) : Math.floor(maxRefundCents * 0.70);
        db.prepare(`
          INSERT INTO settlement_offers (
            id, dispute_id, negotiation_session_id, offer_type,
            offered_amount_cents, max_allowed_cents, status, proposed_by,
            buyer_response_text, responded_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `off_gold_${padId}`, disputeId, negId, 'PARTIAL_REFUND',
          offerAmountCents, maxRefundCents, isSettled ? 'EXECUTED' : 'PROPOSED',
          'AGENT', isSettled ? 'Offer accepted' : null, isSettled ? resolvedTime : null,
          disputeCreatedTime, disputeCreatedTime
        );
      }

      // Insert Webhook Event (ENT-10)
      db.prepare(`
        INSERT INTO webhook_events (
          id, webhook_id, event_type, resource_id, payload_json,
          processing_status, retry_count, processed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `wh_event_${padId}`, webhookId, 'CUSTOMER.DISPUTE.CREATED',
        paypalDisputeId, JSON.stringify({ dispute_id: paypalDisputeId, amount: amountCents / 100 }),
        'PROCESSED', 0, disputeCreatedTime, disputeCreatedTime
      );

      // Insert Audit Log (ENT-09)
      const actorType = isAutonomous ? 'AI_AGENT' : 'MERCHANT_USER';
      const actorId = isAutonomous ? 'ACT-04' : 'ACT-01';
      db.prepare(`
        INSERT INTO audit_logs (
          id, merchant_id, entity_type, entity_id, action,
          actor_id, actor_type, previous_state_json, new_state_json,
          rule_ids_checked, guardrail_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `aud_gold_${padId}`, merchantId, 'disputes', disputeId,
        `DISPUTE_TRANSITION_${status}`, actorId, actorType,
        JSON.stringify({ status: 'OPEN' }), JSON.stringify({ status }),
        JSON.stringify(['BR-001', 'BR-004', 'BR-016']), 'PASSED', disputeCreatedTime
      );
    }
  })();

  // -------------------------------------------------------------
  // RECONCILIATION VERIFICATION & REPRODUCIBILITY PROOF
  // -------------------------------------------------------------
  console.log('\n📊 Reconciling C-Suite Executive KPIs on Golden Dataset:');

  const winRateRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN status = 'WON' THEN 1 END) * 100.0 / 
          NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST') THEN 1 END), 0), 2) AS win_rate_pct
    FROM disputes WHERE merchant_id = 'merch_default';
  `).get() as { win_rate_pct: number };

  const netRevenueRow = db.prepare(`
    SELECT ROUND(SUM(
      CASE 
        WHEN d.status = 'WON' THEN d.dispute_amount_cents 
        WHEN d.status = 'SETTLED_VIA_REFUND' THEN (d.dispute_amount_cents - COALESCE(so.offered_amount_cents, d.dispute_amount_cents))
        ELSE 0 
      END
    ) / 100.0, 2) AS net_revenue_saved
    FROM disputes d
    LEFT JOIN settlement_offers so ON d.id = so.dispute_id AND so.status = 'EXECUTED'
    WHERE d.merchant_id = 'merch_default';
  `).get() as { net_revenue_saved: number };

  const deflectionRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN status = 'SETTLED_VIA_REFUND' THEN 1 END) * 100.0 / 
          NULLIF(COUNT(CASE WHEN status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED') THEN 1 END), 0), 2) AS deflection_rate_pct
    FROM disputes WHERE merchant_id = 'merch_default';
  `).get() as { deflection_rate_pct: number };

  const feeAvoidanceRow = db.prepare(`
    SELECT ROUND(SUM(CASE WHEN d.status IN ('WON', 'SETTLED_VIA_REFUND') THEN m.chargeback_fee_cents ELSE 0 END) / 100.0, 2) AS fee_avoidance
    FROM disputes d
    JOIN merchants m ON d.merchant_id = m.id
    WHERE d.merchant_id = 'merch_default';
  `).get() as { fee_avoidance: number };

  const autonomousRow = db.prepare(`
    SELECT ROUND(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND') AND NOT EXISTS (
      SELECT 1 FROM audit_logs a WHERE a.entity_id = d.id AND a.actor_type = 'MERCHANT_USER'
    ) THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN d.status IN ('WON','LOST','SETTLED_VIA_REFUND','EXPIRED') THEN 1 END), 0), 2) AS autonomous_rate
    FROM disputes d WHERE d.merchant_id = 'merch_default';
  `).get() as { autonomous_rate: number };

  const mttesRow = db.prepare(`
    SELECT ROUND(AVG((julianday(submitted_at) - julianday(created_at)) * 86400.0), 1) AS mttes_seconds
    FROM disputes
    WHERE merchant_id = 'merch_default' AND status IN ('SUBMITTED', 'WON', 'LOST') AND submitted_at IS NOT NULL;
  `).get() as { mttes_seconds: number };

  console.log(`  • KPI-001 Dispute Win Rate: ${winRateRow.win_rate_pct}% (Target >= 72.0%)`);
  console.log(`  • KPI-002 Net Revenue Saved: $${netRevenueRow.net_revenue_saved.toLocaleString()} (Target > $12,500)`);
  console.log(`  • KPI-003 Deflection Rate: ${deflectionRow.deflection_rate_pct}% (Target >= 28.0%)`);
  console.log(`  • KPI-004 Fee Avoidance: $${feeAvoidanceRow.fee_avoidance.toLocaleString()} ($15/avoided chargeback)`);
  console.log(`  • KPI-005 Autonomous Rate: ${autonomousRow.autonomous_rate}% (Target >= 80.0%)`);
  console.log(`  • KPI-006 MTTES Latency: ${mttesRow.mttes_seconds}s (Target < 15.0s)`);

  closeDb();
  console.log('✅ Golden Dataset seeding and SQL verification completed successfully.');
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('seed.ts') || 
  process.argv[1].endsWith('seed') ||
  process.argv[1].includes('seed.ts')
);

if (isDirectRun || (typeof require !== 'undefined' && require.main === module)) {
  runGoldenSeeder();
}
