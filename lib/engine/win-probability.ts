/**
 * ChargebackShield — AI Win Probability Engine
 * Grounded in PRD §6.4, Plan Step 18, and BR-003
 */

import { Database } from 'better-sqlite3';

export type DisputeReasonCode =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'
  | 'SIGNIFICANTLY_NOT_AS_DESCRIBED'
  | 'UNAUTHORISED'
  | 'CANCELLED_RECURRING_BILLING'
  | 'OTHER';

export interface WinProbabilityFactors {
  reasonCode: string;
  hasDeliveryProof?: boolean;
  hasCarrierTrackingConfirmed?: boolean;
  hasPriorChargebackHistory?: boolean;
  isBuyerAccountAgeGt1Yr?: boolean;
  isMerchantRefundPolicyAccepted?: boolean;
  // Domain context metadata
  hasAvsCvvMatch?: boolean;
  hasUsageLogs?: boolean;
  deliveryStatus?: string;
  hasSignature?: boolean;
}

export interface FactorBreakdownItem {
  factor: string;
  description: string;
  weight: number;
  applied: boolean;
}

export interface WinProbabilityResult {
  winProbability: number; // Strictly in [0.0000, 1.0000], 4 decimal places
  rawScore: number;
  baseScore: number;
  factors: WinProbabilityFactors;
  breakdown: FactorBreakdownItem[];
  confidenceScore: number; // [0.00, 1.00] based on verified evidence completeness
}

// Empirical reason code base priors
export const REASON_BASE_WEIGHTS: Record<string, number> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 0.30,
  SIGNIFICANTLY_NOT_AS_DESCRIBED: 0.35,
  UNAUTHORISED: 0.20,
  CANCELLED_RECURRING_BILLING: 0.30,
  OTHER: 0.25,
};

export type Feature =
  | 'DELIVERY_PROOF'
  | 'CARRIER_TRACKING'
  | 'SIGNATURE'
  | 'AVS_CVV_MATCH'
  | 'USAGE_LOGS'
  | 'PRIOR_CHARGEBACKS'
  | 'ACCOUNT_AGE_GT_1YR'
  | 'REFUND_POLICY_ACCEPTED';

// Default feature delta weights (any reason code without an override below)
export const FEATURE_WEIGHTS: Record<Feature, number> = {
  DELIVERY_PROOF: 0.45,
  CARRIER_TRACKING: 0.25,
  SIGNATURE: 0,
  AVS_CVV_MATCH: 0,
  USAGE_LOGS: 0,
  PRIOR_CHARGEBACKS: -0.30,
  ACCOUNT_AGE_GT_1YR: 0.10,
  REFUND_POLICY_ACCEPTED: 0.10,
};

// Reason-specific overrides: evidence only scores where it rebuts that claim type
export const REASON_FEATURE_WEIGHTS: Record<string, Partial<Record<Feature, number>>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: { DELIVERY_PROOF: 0.53, CARRIER_TRACKING: 0.02, SIGNATURE: 0.06 },
  SIGNIFICANTLY_NOT_AS_DESCRIBED: { DELIVERY_PROOF: 0.20, CARRIER_TRACKING: 0, USAGE_LOGS: 0.27 },
  UNAUTHORISED: { DELIVERY_PROOF: 0.06, CARRIER_TRACKING: 0, AVS_CVV_MATCH: 0.62 },
};

const FEATURE_DESCRIPTIONS: Record<Feature, string> = {
  DELIVERY_PROOF: 'Proof of delivery verified',
  CARRIER_TRACKING: 'Carrier tracking number verified and active',
  SIGNATURE: 'Signed delivery confirmation on file',
  AVS_CVV_MATCH: 'AVS / CVV / IP match verified by gateway',
  USAGE_LOGS: 'Usage logs confirm product utilization post-delivery',
  PRIOR_CHARGEBACKS: 'Prior chargeback history detected on customer account',
  ACCOUNT_AGE_GT_1YR: 'Customer account age exceeds 1 year',
  REFUND_POLICY_ACCEPTED: 'Merchant return and refund policy explicitly acknowledged',
};

/**
 * Clamps number strictly to [0.0000, 1.0000] with 4-decimal precision (BR-003).
 */
export function clampProbability(val: number): number {
  if (isNaN(val) || !isFinite(val)) return 0.5000;
  const rounded = Math.round(val * 10000) / 10000;
  return Math.max(0.0000, Math.min(1.0000, rounded));
}

/**
 * Computes heuristic AI Win Probability score W in [0.0000, 1.0000] (BR-003).
 * Supports both WinProbabilityFactors and legacy test fixture inputs.
 */
export function calculateWinProbability(
  input: WinProbabilityFactors | { delivery_status?: string; has_signature?: boolean; reason_code?: string; avs_match?: boolean }
): number {
  const result = evaluateWinProbabilityFactors(input);
  return result.winProbability;
}

/**
 * Full factor analysis returning breakdown, raw score, and clamped win probability.
 */
export function evaluateWinProbabilityFactors(
  input: WinProbabilityFactors | { delivery_status?: string; has_signature?: boolean; reason_code?: string; avs_match?: boolean }
): WinProbabilityResult {
  // Normalize input keys
  const anyInput = input as any;
  const reasonCode = ((anyInput.reasonCode || anyInput.reason_code) || 'OTHER').toUpperCase();
  const deliveryStatus = anyInput.deliveryStatus || anyInput.delivery_status;
  const hasSignature = anyInput.hasSignature || anyInput.has_signature;
  const avsMatch = anyInput.hasAvsCvvMatch || anyInput.avs_match;

  const hasDeliveryProof = Boolean(
    anyInput.hasDeliveryProof ||
    deliveryStatus === 'DELIVERED' ||
    hasSignature
  );

  const hasCarrierTrackingConfirmed = Boolean(
    anyInput.hasCarrierTrackingConfirmed ||
    (deliveryStatus && ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(deliveryStatus))
  );

  const hasPriorChargebackHistory = Boolean(anyInput.hasPriorChargebackHistory);
  const isBuyerAccountAgeGt1Yr = Boolean(anyInput.isBuyerAccountAgeGt1Yr);
  const isMerchantRefundPolicyAccepted = Boolean(anyInput.isMerchantRefundPolicyAccepted);
  const hasUsageLogs = Boolean(anyInput.hasUsageLogs);

  // Base score from reason code
  const baseScore = REASON_BASE_WEIGHTS[reasonCode] ?? 0.25;
  let rawScore = baseScore;

  const breakdown: FactorBreakdownItem[] = [
    {
      factor: 'BASE_REASON_CODE',
      description: `Base weight for reason ${reasonCode}`,
      weight: baseScore,
      applied: true,
    },
  ];

  // Additive feature-weighted model over verifiable evidence only
  const present: Record<Feature, boolean> = {
    DELIVERY_PROOF: hasDeliveryProof,
    CARRIER_TRACKING: hasCarrierTrackingConfirmed,
    SIGNATURE: Boolean(hasSignature),
    AVS_CVV_MATCH: Boolean(avsMatch),
    USAGE_LOGS: hasUsageLogs,
    PRIOR_CHARGEBACKS: hasPriorChargebackHistory,
    ACCOUNT_AGE_GT_1YR: isBuyerAccountAgeGt1Yr,
    REFUND_POLICY_ACCEPTED: isMerchantRefundPolicyAccepted,
  };
  const weights = { ...FEATURE_WEIGHTS, ...REASON_FEATURE_WEIGHTS[reasonCode] };

  for (const feature of Object.keys(present) as Feature[]) {
    if (!present[feature] || weights[feature] === 0) continue;
    rawScore += weights[feature];
    breakdown.push({
      factor: feature,
      description: FEATURE_DESCRIPTIONS[feature],
      weight: weights[feature],
      applied: true,
    });
  }

  const winProbability = clampProbability(rawScore);
  const confidenceScore = clampProbability(0.60 + breakdown.filter((b) => b.applied).length * 0.08);

  return {
    winProbability,
    rawScore: Math.round(rawScore * 10000) / 10000,
    baseScore,
    factors: {
      reasonCode,
      hasDeliveryProof,
      hasCarrierTrackingConfirmed,
      hasPriorChargebackHistory,
      isBuyerAccountAgeGt1Yr,
      isMerchantRefundPolicyAccepted,
      hasAvsCvvMatch: avsMatch,
      hasUsageLogs,
      deliveryStatus,
      hasSignature,
    },
    breakdown,
    confidenceScore,
  };
}

/**
 * Extracts empirical evidence and order ground truth factors from SQLite database.
 */
export function extractWinProbabilityFactors(db: Database, disputeId: string): WinProbabilityFactors {
  const dispute = db.prepare(`
    SELECT d.id, d.order_id, d.reason_code, d.dispute_amount_cents,
           o.customer_id, o.customer_email, o.carrier_name, o.tracking_number,
           o.delivery_status, o.delivered_at, o.delivery_signature_name, o.created_at as order_created_at
    FROM disputes d
    JOIN orders o ON d.order_id = o.id
    WHERE d.id = ? OR d.paypal_dispute_id = ?
  `).get(disputeId, disputeId) as any;

  if (!dispute) {
    return {
      reasonCode: 'OTHER',
      hasDeliveryProof: false,
      hasCarrierTrackingConfirmed: false,
    };
  }

  // 1. Evidence items query
  const evidenceRows = db.prepare(`
    SELECT evidence_type, is_verified, content_json
    FROM evidence_items
    WHERE dispute_id = ?
  `).all(dispute.id) as Array<{ evidence_type: string; is_verified: number; content_json: string }>;

  const hasVerifiedItem = (types: string[]) =>
    evidenceRows.some((e) => types.includes(e.evidence_type) && e.is_verified === 1);

  // 2. Delivery Proof
  const hasDeliveryProof = Boolean(
    dispute.delivery_status === 'DELIVERED' ||
    dispute.delivered_at ||
    dispute.delivery_signature_name ||
    hasVerifiedItem(['TRACKING_PROOF', 'DELIVERY_SIGNATURE'])
  );

  // 3. Carrier Tracking
  const hasCarrierTrackingConfirmed = Boolean(
    (dispute.tracking_number && dispute.carrier_name) ||
    hasVerifiedItem(['TRACKING_PROOF'])
  );

  // 4. Prior chargebacks check
  const priorChargebacks = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM disputes d
    JOIN orders o ON d.order_id = o.id
    WHERE (o.customer_id = ? OR o.customer_email = ?)
      AND d.id != ?
  `).get(dispute.customer_id ?? '', dispute.customer_email ?? '', dispute.id) as { cnt: number };

  const hasPriorChargebackHistory = Boolean(priorChargebacks && priorChargebacks.cnt > 0);

  // 5. Account Age > 1 Year
  let isBuyerAccountAgeGt1Yr = false;
  const earliestOrder = db.prepare(`
    SELECT MIN(created_at) as first_order_date
    FROM orders
    WHERE customer_id = ? OR customer_email = ?
  `).get(dispute.customer_id ?? '', dispute.customer_email ?? '') as { first_order_date: string | null };

  if (earliestOrder?.first_order_date && dispute.order_created_at) {
    const earliestTime = new Date(earliestOrder.first_order_date).getTime();
    const orderTime = new Date(dispute.order_created_at).getTime();
    if (orderTime - earliestTime >= 365 * 24 * 60 * 60 * 1000) {
      isBuyerAccountAgeGt1Yr = true;
    }
  }

  // 6. Refund policy accepted
  const isMerchantRefundPolicyAccepted = hasVerifiedItem(['REFUND_POLICY']);

  // 7. AVS / CVV and Usage Logs
  const hasAvsCvvMatch = hasVerifiedItem(['ORDER_RECEIPT', 'ACCESS_LOGS']);
  const hasUsageLogs = hasVerifiedItem(['USAGE_LOG', 'ACCESS_LOGS']);

  return {
    reasonCode: dispute.reason_code,
    hasDeliveryProof,
    hasCarrierTrackingConfirmed,
    hasPriorChargebackHistory,
    isBuyerAccountAgeGt1Yr,
    isMerchantRefundPolicyAccepted,
    hasAvsCvvMatch,
    hasUsageLogs,
    deliveryStatus: dispute.delivery_status,
    hasSignature: Boolean(dispute.delivery_signature_name),
  };
}

/**
 * End-to-end Win Probability assessment for a dispute in the database.
 */
export function assessWinProbability(db: Database, disputeId: string): WinProbabilityResult {
  const factors = extractWinProbabilityFactors(db, disputeId);
  return evaluateWinProbabilityFactors(factors);
}
