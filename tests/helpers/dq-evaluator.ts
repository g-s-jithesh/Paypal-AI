import { Database } from 'better-sqlite3';

export interface DQDimensions {
  completeness: number;
  validity: number;
  referentialIntegrity: number;
  uniqueness: number;
  chronology: number;
  compositeScore: number;
}

export function evaluateDataQuality(db: Database): DQDimensions {
  const tables = [
    'merchants',
    'orders',
    'disputes',
    'evidence_items',
    'ai_assessments',
    'negotiation_sessions',
    'settlement_offers',
    'policy_rules',
    'audit_logs',
    'webhook_events',
  ];

  // 1. Completeness (C): Ratio of non-null required cells to total required cells
  let totalRequiredCells = 0;
  let populatedRequiredCells = 0;

  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: any;
    }>;
    const requiredCols = columns.filter((col) => col.notnull === 1);

    const rowCount = (db.prepare(`SELECT count(*) as count FROM ${table}`).get() as { count: number }).count;
    if (rowCount === 0) continue;

    for (const col of requiredCols) {
      totalRequiredCells += rowCount;
      const populated = (
        db.prepare(`SELECT count(*) as count FROM ${table} WHERE ${col.name} IS NOT NULL`).get() as { count: number }
      ).count;
      populatedRequiredCells += populated;
    }
  }

  const completeness = totalRequiredCells > 0 ? (populatedRequiredCells / totalRequiredCells) * 100 : 100;

  // 2. Validity (V): Domain checks (amounts positive, prob bounds, status enums)
  let totalValidityChecks = 0;
  let passedValidityChecks = 0;

  // Check orders
  const ordersCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN amount_cents > 0 AND delivery_status IN ('UNFULFILLED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED_TO_SENDER', 'LOST_IN_TRANSIT') THEN 1 ELSE 0 END) as valid
    FROM orders
  `).get() as { total: number; valid: number };
  totalValidityChecks += ordersCheck.total;
  passedValidityChecks += ordersCheck.valid;

  // Check disputes
  const disputesCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN dispute_amount_cents > 0 
                AND status IN ('OPEN', 'EVIDENCE_GATHERING', 'NEGOTIATING', 'READY_FOR_REVIEW', 'SUBMITTED', 'WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
                AND reason_code IN ('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'SIGNIFICANTLY_NOT_AS_DESCRIBED', 'UNAUTHORISED', 'CANCELLED_RECURRING_BILLING', 'OTHER')
          THEN 1 ELSE 0 END) as valid
    FROM disputes
  `).get() as { total: number; valid: number };
  totalValidityChecks += disputesCheck.total;
  passedValidityChecks += disputesCheck.valid;

  // Check ai_assessments
  const asmtCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN win_probability >= 0.0 AND win_probability <= 1.0 
                AND confidence_score >= 0.0 AND confidence_score <= 1.0
                AND execution_latency_ms >= 0
          THEN 1 ELSE 0 END) as valid
    FROM ai_assessments
  `).get() as { total: number; valid: number };
  totalValidityChecks += asmtCheck.total;
  passedValidityChecks += asmtCheck.valid;

  // Check evidence_items
  const evidenceCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN LENGTH(sha256_hash) = 64 AND is_verified IN (0, 1) THEN 1 ELSE 0 END) as valid
    FROM evidence_items
  `).get() as { total: number; valid: number };
  totalValidityChecks += evidenceCheck.total;
  passedValidityChecks += evidenceCheck.valid;

  const validity = totalValidityChecks > 0 ? (passedValidityChecks / totalValidityChecks) * 100 : 100;

  // 3. Referential Integrity (R): PRAGMA foreign_key_check & orphan queries
  const fkViolations = (db.prepare('PRAGMA foreign_key_check').all() as any[]).length;
  const referentialIntegrity = fkViolations === 0 ? 100.0 : 0.0;

  // 4. Uniqueness (U): Count distinct PKs vs count total PKs across tables
  let totalKeys = 0;
  let uniqueKeys = 0;

  for (const table of tables) {
    const row = db.prepare(`SELECT count(id) as total, count(DISTINCT id) as uniqueCount FROM ${table}`).get() as {
      total: number;
      uniqueCount: number;
    };
    totalKeys += row.total;
    uniqueKeys += row.uniqueCount;
  }

  const uniqueness = totalKeys > 0 ? (uniqueKeys / totalKeys) * 100 : 100;

  // 5. Chronological Consistency (T)
  const disputesTimeCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN seller_response_due_at > created_at 
                AND (submitted_at IS NULL OR submitted_at >= created_at)
                AND (resolved_at IS NULL OR resolved_at >= created_at)
          THEN 1 ELSE 0 END) as valid
    FROM disputes
  `).get() as { total: number; valid: number };

  const ordersTimeCheck = db.prepare(`
    SELECT 
      count(*) as total,
      SUM(CASE WHEN (shipped_at IS NULL OR shipped_at >= created_at)
                AND (delivered_at IS NULL OR delivered_at >= COALESCE(shipped_at, created_at))
          THEN 1 ELSE 0 END) as valid
    FROM orders
  `).get() as { total: number; valid: number };

  const totalTimeChecks = disputesTimeCheck.total + ordersTimeCheck.total;
  const passedTimeChecks = disputesTimeCheck.valid + ordersTimeCheck.valid;
  const chronology = totalTimeChecks > 0 ? (passedTimeChecks / totalTimeChecks) * 100 : 100;

  const compositeScore = Number(((completeness + validity + referentialIntegrity + uniqueness + chronology) / 5).toFixed(2));

  return {
    completeness: Number(completeness.toFixed(2)),
    validity: Number(validity.toFixed(2)),
    referentialIntegrity: Number(referentialIntegrity.toFixed(2)),
    uniqueness: Number(uniqueness.toFixed(2)),
    chronology: Number(chronology.toFixed(2)),
    compositeScore,
  };
}
