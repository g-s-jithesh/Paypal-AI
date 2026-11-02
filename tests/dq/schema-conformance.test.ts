import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { createTestDb } from '../helpers/db-helper';

describe('Data Quality: Schema Conformance (ENT-01 to ENT-10)', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('TC-DQ-SCH-001: Table Completeness - exactly all 10 core entities exist in SQLite catalog', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    const expectedEntities = [
      'ai_assessments',
      'audit_logs',
      'disputes',
      'evidence_items',
      'merchants',
      'negotiation_sessions',
      'orders',
      'policy_rules',
      'settlement_offers',
      'webhook_events',
    ];

    expect(tableNames.sort()).toEqual(expectedEntities.sort());
  });

  it('TC-DQ-SCH-002: Column Definitions & Types for core entities', () => {
    // Check disputes columns
    const disputeCols = db.prepare('PRAGMA table_info(disputes)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const disputeColMap = new Map(disputeCols.map((c) => [c.name, c]));
    expect(disputeColMap.get('id')?.type).toBe('TEXT');
    expect(disputeColMap.get('id')?.pk).toBe(1);
    expect(disputeColMap.get('merchant_id')?.notnull).toBe(1);
    expect(disputeColMap.get('order_id')?.notnull).toBe(1);
    expect(disputeColMap.get('paypal_dispute_id')?.notnull).toBe(1);
    expect(disputeColMap.get('reason_code')?.notnull).toBe(1);
    expect(disputeColMap.get('status')?.notnull).toBe(1);
    expect(disputeColMap.get('dispute_amount_cents')?.type).toBe('INTEGER');
    expect(disputeColMap.get('dispute_amount_cents')?.notnull).toBe(1);
    expect(disputeColMap.get('version')?.type).toBe('INTEGER');

    // Check orders columns
    const orderCols = db.prepare('PRAGMA table_info(orders)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const orderColMap = new Map(orderCols.map((c) => [c.name, c]));
    expect(orderColMap.get('amount_cents')?.type).toBe('INTEGER');
    expect(orderColMap.get('customer_email')?.notnull).toBe(1);
    expect(orderColMap.get('customer_name')?.notnull).toBe(1);

    // Check ai_assessments columns
    const asmtCols = db.prepare('PRAGMA table_info(ai_assessments)').all() as Array<{
      name: string;
      type: string;
    }>;
    const asmtColMap = new Map(asmtCols.map((c) => [c.name, c]));
    expect(asmtColMap.get('win_probability')?.type).toBe('REAL');
    expect(asmtColMap.get('expected_value_cents')?.type).toBe('INTEGER');
    expect(asmtColMap.get('confidence_score')?.type).toBe('REAL');
    expect(asmtColMap.get('execution_latency_ms')?.type).toBe('INTEGER');
  });

  it('TC-DQ-SCH-003: Unique and Primary Key Constraints', () => {
    // orders.paypal_order_id unique
    const orderIndexes = db.prepare('PRAGMA index_list(orders)').all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(orderIndexes.some((idx) => idx.unique === 1)).toBe(true);

    // disputes.paypal_dispute_id unique
    const disputeIndexes = db.prepare('PRAGMA index_list(disputes)').all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(disputeIndexes.some((idx) => idx.unique === 1)).toBe(true);

    // webhook_events.webhook_id unique
    const webhookIndexes = db.prepare('PRAGMA index_list(webhook_events)').all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(webhookIndexes.some((idx) => idx.unique === 1)).toBe(true);
  });

  it('TC-DQ-SCH-004: Performance Index Verification across database', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    const requiredIndexes = [
      'idx_merchants_mode',
      'idx_orders_merchant_id',
      'idx_orders_paypal_id',
      'idx_orders_tracking',
      'idx_orders_delivery_status',
      'idx_disputes_merchant_status_due',
      'idx_disputes_status_merchant',
      'idx_disputes_order_id',
      'idx_disputes_paypal_id',
      'idx_disputes_track',
      'idx_evidence_dispute_type',
      'idx_evidence_sha256',
      'idx_assessments_dispute_created',
      'idx_negotiation_dispute',
      'idx_negotiation_token',
      'idx_settlement_dispute_status',
      'idx_settlement_session',
      'idx_audit_entity_action',
      'idx_audit_merchant_created',
      'idx_audit_actor_type',
      'idx_webhooks_webhook_id',
      'idx_webhooks_resource_status',
      'idx_policy_rules_merchant_active',
    ];

    for (const reqIdx of requiredIndexes) {
      expect(indexNames).toContain(reqIdx);
    }
  });
});
