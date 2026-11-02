/**
 * ChargebackShield — Domain-Specific Test Assertions & Invariant Checkers
 */

import { SqliteDbAdapter } from './db-helper';

export function assertIntegerCents(value: any, name: string = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Assertion failed: ${name} must be a non-negative integer cents value, got: ${value}`);
  }
}

export function assertSha256(hash: string) {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Assertion failed: Expected valid 64-char lowercase hexadecimal SHA-256 hash, got: ${hash}`);
  }
}

export function assertIsoDate(dateStr: string) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    throw new Error(`Assertion failed: Expected valid ISO-8601 date string, got: ${dateStr}`);
  }
}

export function assertRefundCap(offeredCents: number, disputeAmountCents: number, maxPct: number) {
  const maxAllowed = Math.floor((disputeAmountCents * maxPct) / 1.0);
  if (offeredCents > maxAllowed) {
    throw new Error(
      `BR-004 Violation: Offered amount (${offeredCents} cents) exceeds maximum allowed cap (${maxAllowed} cents for ${disputeAmountCents} cents at ${maxPct * 100}%)`
    );
  }
}

export function calculateExpectedEV(winProb: number, disputeAmountCents: number, feeCents: number, opsCostCents: number): number {
  return Math.round(winProb * disputeAmountCents - (1.0 - winProb) * feeCents - opsCostCents);
}

export function assertAuditLogExists(
  db: SqliteDbAdapter,
  entityId: string,
  action?: string
) {
  const query = action
    ? 'SELECT * FROM audit_logs WHERE entity_id = ? AND action = ?'
    : 'SELECT * FROM audit_logs WHERE entity_id = ?';
  const params = action ? [entityId, action] : [entityId];
  const row = db.prepare(query).get(...params);
  if (!row) {
    throw new Error(`Assertion failed: Missing mandatory audit_logs record for entity ${entityId}${action ? ` with action ${action}` : ''}`);
  }
  return row;
}

export function assertNoPii(text: string) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneRegex = /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g;

  if (emailRegex.test(text)) {
    throw new Error(`PII Leakage Detected: Raw email address found in output: ${text}`);
  }
  if (phoneRegex.test(text)) {
    throw new Error(`PII Leakage Detected: Raw phone number found in output: ${text}`);
  }
}
