/**
 * ChargebackShield — Immutable Audit Logger for Firewall & MCP Subsystem
 * Strictly satisfies ENT-09 and BR-012 (append-only ledger)
 */

import { Database } from 'better-sqlite3';
import { getDb } from '../db';
import { GuardrailStatus } from './types';

export interface AuditLogEntryParams {
  merchantId: string;
  entityType: 'disputes' | 'settlement_offers' | 'negotiation_sessions' | 'webhook_events';
  entityId: string;
  action: string;
  actorId?: string;
  actorType?: 'SYSTEM' | 'AI_AGENT' | 'MERCHANT_USER' | 'BUYER' | 'EXTERNAL_WEBHOOK';
  previousStateJson?: any;
  newStateJson: any;
  ruleIdsChecked: string[];
  guardrailStatus: 'APPROVED' | 'PASSED' | 'BLOCKED' | 'WARNING';
  ipAddress?: string | null;
}

/**
 * Appends a tamper-evident, immutable audit record to ENT-09.
 * Strictly complies with BR-012, normalizing 'APPROVED' -> 'PASSED' for DB CHECK constraint.
 */
export function recordFirewallAuditLog(params: AuditLogEntryParams, db?: Database): string {
  const conn = db ?? getDb();
  const auditId = `aud_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // Normalization: Map 'APPROVED' to 'PASSED' to strictly adhere to DB schema check constraint
  const normalizedStatus: GuardrailStatus =
    params.guardrailStatus === 'APPROVED' || params.guardrailStatus === 'PASSED'
      ? 'PASSED'
      : params.guardrailStatus === 'BLOCKED'
      ? 'BLOCKED'
      : 'WARNING';

  const stmt = conn.prepare(`
    INSERT INTO audit_logs (
      id, merchant_id, entity_type, entity_id, action,
      actor_id, actor_type, previous_state_json, new_state_json,
      rule_ids_checked, guardrail_status, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  stmt.run(
    auditId,
    params.merchantId,
    params.entityType,
    params.entityId,
    params.action,
    params.actorId ?? 'ACT-04',
    params.actorType ?? 'AI_AGENT',
    params.previousStateJson ? (typeof params.previousStateJson === 'string' ? params.previousStateJson : JSON.stringify(params.previousStateJson)) : null,
    typeof params.newStateJson === 'string' ? params.newStateJson : JSON.stringify(params.newStateJson),
    JSON.stringify(params.ruleIdsChecked),
    normalizedStatus,
    params.ipAddress ?? null
  );

  return auditId;
}
