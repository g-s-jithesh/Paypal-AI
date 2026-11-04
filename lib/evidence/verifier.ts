/**
 * ChargebackShield — Evidence Auto-Assembler & SHA-256 Zero-Hallucination Verifier
 * Code-level enforcement of BR-008, BR-009, and BR-010
 * Grounded in PRD §6.2, §6.3, and DDDL Gate G4/G6 specifications
 */

import crypto from 'crypto';
import { Database } from 'better-sqlite3';
import { getDb } from '../db';

export interface EvidenceVerificationResult {
  is_verified: boolean;
  error?: string;
  field?: string;
  sha256_hash?: string;
  details?: Record<string, any>;
}

export interface AssembledEvidencePackage {
  order_id: string;
  dispute_id: string;
  tracking_number: string | null;
  carrier_name: string | null;
  delivery_status: string;
  delivered_at: string | null;
  signature: string | null;
  amount_cents: number;
  item_summary: string;
  customer_name: string;
  customer_email: string;
  canonical_json: string;
  sha256_hash: string;
  is_verified: boolean;
}

export interface VerificationReport {
  is_verified: boolean;
  order_id: string;
  sha256_hash: string;
  checks: {
    order_exists: boolean;
    tracking_number_valid: boolean;
    carrier_valid: boolean;
    delivered_at_valid: boolean;
    signature_valid: boolean;
  };
  errors: string[];
}

/**
 * Computes deterministic SHA-256 hexadecimal hash from string or object with sorted keys.
 */
export function computeSha256(content: object | string): string {
  const str = typeof content === 'string'
    ? content
    : JSON.stringify(content, Object.keys(content).sort());
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Validates evidence facts against Database ground truth (BR-008).
 * Strictly guards against fabricated tracking numbers, carriers, and delivery timestamps.
 */
export function verifyEvidenceFacts(
  db: Database,
  orderId: string,
  evidenceInput: string | Record<string, any>
): EvidenceVerificationResult {
  const order = db.prepare(`
    SELECT id, tracking_number, carrier_name, delivery_status, delivered_at, delivery_signature_name, amount_cents
    FROM orders
    WHERE id = ?
  `).get(orderId) as any;

  if (!order) {
    return { is_verified: false, error: 'ORDER_NOT_FOUND', field: 'order_id' };
  }

  let parsed: Record<string, any>;
  try {
    parsed = typeof evidenceInput === 'string' ? JSON.parse(evidenceInput) : evidenceInput;
  } catch {
    return { is_verified: false, error: 'INVALID_JSON_PAYLOAD' };
  }

  // 1. Check Tracking Number Ground Truth (BR-008)
  if (parsed.tracking_number && parsed.tracking_number !== order.tracking_number) {
    return {
      is_verified: false,
      error: 'HALLUCINATED_TRACKING_NUMBER',
      field: 'tracking_number',
      details: {
        provided: parsed.tracking_number,
        expected: order.tracking_number,
      },
    };
  }

  // 2. Check Carrier Name Ground Truth (BR-008)
  const carrierProvided = parsed.carrier_name || parsed.carrier;
  if (carrierProvided && order.carrier_name && carrierProvided !== order.carrier_name) {
    return {
      is_verified: false,
      error: 'HALLUCINATED_CARRIER',
      field: 'carrier_name',
      details: {
        provided: carrierProvided,
        expected: order.carrier_name,
      },
    };
  }

  // 3. Check Delivery Date Ground Truth (BR-008)
  if (parsed.delivered_at && order.delivered_at && parsed.delivered_at !== order.delivered_at) {
    return {
      is_verified: false,
      error: 'HALLUCINATED_DELIVERY_DATE',
      field: 'delivered_at',
      details: {
        provided: parsed.delivered_at,
        expected: order.delivered_at,
      },
    };
  }

  // 4. Check Signature Name if present
  const sigProvided = parsed.signature || parsed.delivery_signature_name;
  if (sigProvided && order.delivery_signature_name && sigProvided !== order.delivery_signature_name) {
    return {
      is_verified: false,
      error: 'HALLUCINATED_SIGNATURE',
      field: 'delivery_signature_name',
      details: {
        provided: sigProvided,
        expected: order.delivery_signature_name,
      },
    };
  }

  const hash = computeSha256(parsed);
  return {
    is_verified: true,
    sha256_hash: hash,
  };
}

/**
 * Auto-assembles multi-source evidence package from Order and Shipping records.
 */
export function assembleEvidencePackage(
  db: Database,
  orderId: string,
  disputeId: string
): AssembledEvidencePackage {
  const order = db.prepare(`
    SELECT * FROM orders WHERE id = ?
  `).get(orderId) as any;

  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  const payload = {
    order_id: order.id,
    dispute_id: disputeId,
    amount_cents: order.amount_cents,
    currency: order.currency,
    carrier_name: order.carrier_name,
    tracking_number: order.tracking_number,
    delivery_status: order.delivery_status,
    shipped_at: order.shipped_at,
    delivered_at: order.delivered_at,
    signature: order.delivery_signature_name,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    item_summary: order.item_summary,
  };

  const canonicalJson = JSON.stringify(payload);
  const hash = computeSha256(canonicalJson);
  const verification = verifyEvidenceFacts(db, orderId, canonicalJson);

  return {
    order_id: order.id,
    dispute_id: disputeId,
    tracking_number: order.tracking_number,
    carrier_name: order.carrier_name,
    delivery_status: order.delivery_status,
    delivered_at: order.delivered_at,
    signature: order.delivery_signature_name,
    amount_cents: order.amount_cents,
    item_summary: order.item_summary,
    customer_name: order.customer_name,
    customer_email: order.customer_email,
    canonical_json: canonicalJson,
    sha256_hash: hash,
    is_verified: verification.is_verified,
  };
}

/**
 * Comprehensive verification report matching PROJECT.md interface contract.
 */
export function verifyEvidencePackage(
  packageData: {
    order_id: string;
    tracking_number?: string;
    carrier_name?: string;
    delivered_at?: string;
    signature?: string;
    content?: string | object;
  },
  db?: Database
): VerificationReport {
  const conn = db ?? getDb();
  const errors: string[] = [];
  const checks = {
    order_exists: false,
    tracking_number_valid: false,
    carrier_valid: false,
    delivered_at_valid: false,
    signature_valid: false,
  };

  const order = conn.prepare(`SELECT * FROM orders WHERE id = ?`).get(packageData.order_id) as any;
  if (!order) {
    errors.push('ORDER_NOT_FOUND');
    return {
      is_verified: false,
      order_id: packageData.order_id,
      sha256_hash: computeSha256(packageData.content || packageData),
      checks,
      errors,
    };
  }
  checks.order_exists = true;

  if (packageData.tracking_number) {
    if (packageData.tracking_number === order.tracking_number) {
      checks.tracking_number_valid = true;
    } else {
      errors.push('HALLUCINATED_TRACKING_NUMBER');
    }
  } else {
    checks.tracking_number_valid = true;
  }

  if (packageData.carrier_name) {
    if (!order.carrier_name || packageData.carrier_name === order.carrier_name) {
      checks.carrier_valid = true;
    } else {
      errors.push('HALLUCINATED_CARRIER');
    }
  } else {
    checks.carrier_valid = true;
  }

  if (packageData.delivered_at) {
    if (!order.delivered_at || packageData.delivered_at === order.delivered_at) {
      checks.delivered_at_valid = true;
    } else {
      errors.push('HALLUCINATED_DELIVERY_DATE');
    }
  } else {
    checks.delivered_at_valid = true;
  }

  if (packageData.signature) {
    if (!order.delivery_signature_name || packageData.signature === order.delivery_signature_name) {
      checks.signature_valid = true;
    } else {
      errors.push('HALLUCINATED_SIGNATURE');
    }
  } else {
    checks.signature_valid = true;
  }

  const rawContent = packageData.content ? packageData.content : packageData;
  const sha256_hash = computeSha256(rawContent);

  return {
    is_verified: errors.length === 0,
    order_id: packageData.order_id,
    sha256_hash,
    checks,
    errors,
  };
}

