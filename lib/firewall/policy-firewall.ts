/**
 * ChargebackShield — Deterministic MCP Policy Firewall
 * Code-level enforcement of BR-004, BR-006, BR-014, and BR-017
 */

import { Database } from 'better-sqlite3';
import { getDb } from '../db';
import {
  FirewallValidationResult,
  SettlementOfferContext,
  HighValueCheckResult,
  RoundsCheckResult,
  PolicyRuleConfig,
} from './types';
import { recordFirewallAuditLog } from './audit-logger';

/**
 * Normalizes percentage: handles both decimal ratio (0.40) and integer percentage (40).
 */
export function normalizeRefundPercentage(pct: number): number {
  if (pct > 1.0) {
    return pct / 100.0;
  }
  return pct >= 0 ? pct : 0.40;
}

/**
 * Computes maximum allowable settlement refund in integer cents (BR-004).
 */
export function calculateRefundCap(disputeAmountCents: number, maxRefundPct: number = 0.40): number {
  if (disputeAmountCents <= 0) return 0;
  const ratio = normalizeRefundPercentage(maxRefundPct);
  return Math.floor(disputeAmountCents * ratio);
}

/**
 * Pure mathematical bounds validator matching Tier 1 test signatures (BR-004).
 */
export function validateSettlementOffer(
  disputeAmountCents: number,
  offeredCents: number,
  maxRefundPct: number = 0.40
): FirewallValidationResult {
  const maxAllowedCents = calculateRefundCap(disputeAmountCents, maxRefundPct);

  if (offeredCents <= 0) {
    return {
      allowed: false,
      clamped: false,
      original_amount_cents: offeredCents,
      final_amount_cents: 0,
      max_allowed_cents: maxAllowedCents,
      reason: 'INVALID_AMOUNT',
      rule_id: 'BR-004',
      guardrail_status: 'BLOCKED',
    };
  }

  if (offeredCents <= maxAllowedCents) {
    return {
      allowed: true,
      clamped: false,
      original_amount_cents: offeredCents,
      final_amount_cents: offeredCents,
      max_allowed_cents: maxAllowedCents,
      guardrail_status: 'PASSED',
    };
  }

  // Violation: clamp strictly to maxAllowedCents
  return {
    allowed: false,
    clamped: true,
    original_amount_cents: offeredCents,
    final_amount_cents: maxAllowedCents,
    max_allowed_cents: maxAllowedCents,
    reason: 'EXCEEDS_POLICY_CAP',
    rule_id: 'BR-004',
    guardrail_status: 'BLOCKED',
  };
}

/**
 * Evaluates the High-Value Gate threshold (BR-006).
 * Disputes > 25000 cents ($250.00) require human analyst review.
 */
export function checkHighValueGate(
  disputeAmountCents: number,
  maxAutoDisputeCents: number = 25000
): HighValueCheckResult {
  const isHighValue = disputeAmountCents > maxAutoDisputeCents;
  return {
    isHighValue,
    thresholdCents: maxAutoDisputeCents,
    disputeAmountCents,
    requiresHumanReview: isHighValue,
    recommendedStatus: isHighValue ? 'READY_FOR_REVIEW' : 'OPEN',
    rule_id: 'BR-006',
  };
}

/**
 * Enforces maximum negotiation rounds cap (BR-017).
 */
export function checkNegotiationRounds(
  currentRounds: number,
  maxRounds: number = 3
): RoundsCheckResult {
  const isExhausted = currentRounds >= maxRounds;
  return {
    allowed: !isExhausted,
    currentRounds,
    maxRounds,
    isExhausted,
    recommendedStatus: isExhausted ? 'READY_FOR_REVIEW' : undefined,
    rule_id: 'BR-017',
  };
}

/**
 * Loads merchant policy rules from SQLite (ENT-08) with fallbacks.
 */
export function loadMerchantPolicy(merchantId: string, db?: Database): PolicyRuleConfig {
  const conn = db ?? getDb();
  const row = conn.prepare(`
    SELECT merchant_id, max_auto_dispute_cents, max_refund_offer_pct,
           min_win_prob_auto_submit, auto_accept_below_cents, min_win_prob_auto_accept,
           default_ops_cost_cents, sla_buffer_hours
    FROM policy_rules
    WHERE merchant_id = ? AND is_active = 1
    ORDER BY version DESC LIMIT 1
  `).get(merchantId) as any;

  if (row) {
    return {
      merchant_id: row.merchant_id,
      max_auto_dispute_cents: row.max_auto_dispute_cents,
      max_refund_offer_pct: row.max_refund_offer_pct,
      min_win_prob_auto_submit: row.min_win_prob_auto_submit,
      auto_accept_below_cents: row.auto_accept_below_cents,
      min_win_prob_auto_accept: row.min_win_prob_auto_accept,
      default_ops_cost_cents: row.default_ops_cost_cents,
      max_negotiation_rounds: 3,
      sla_buffer_hours: row.sla_buffer_hours,
    };
  }

  // Safe baseline defaults
  return {
    merchant_id: merchantId,
    max_auto_dispute_cents: 25000,
    max_refund_offer_pct: 0.40,
    min_win_prob_auto_submit: 0.75,
    auto_accept_below_cents: 3500,
    min_win_prob_auto_accept: 0.35,
    default_ops_cost_cents: 500,
    max_negotiation_rounds: 3,
    sla_buffer_hours: 4,
  };
}

/**
 * Comprehensive Policy Firewall Evaluation against Database.
 * Evaluates BR-004, BR-006, BR-014, and BR-017, and writes audit log.
 */
export function evaluatePolicyFirewall(
  context: SettlementOfferContext,
  db?: Database
): FirewallValidationResult {
  const conn = db ?? getDb();
  const policy = loadMerchantPolicy(context.merchantId, conn);

  // 1. Check High-Value Gate (BR-006)
  const highValue = checkHighValueGate(context.disputeAmountCents, policy.max_auto_dispute_cents);
  if (highValue.isHighValue) {
    recordFirewallAuditLog({
      merchantId: context.merchantId,
      entityType: 'disputes',
      entityId: context.disputeId,
      action: 'HIGH_VALUE_GATE_TRIGGERED',
      actorId: context.actorId,
      actorType: context.actorType,
      newStateJson: {
        dispute_amount_cents: context.disputeAmountCents,
        threshold_cents: policy.max_auto_dispute_cents,
        reason: 'Dispute exceeds $250.00 human review threshold',
      },
      ruleIdsChecked: ['BR-006'],
      guardrailStatus: 'BLOCKED',
      ipAddress: context.ipAddress,
    }, conn);

    return {
      allowed: false,
      clamped: false,
      original_amount_cents: context.offeredCents,
      final_amount_cents: 0,
      max_allowed_cents: calculateRefundCap(context.disputeAmountCents, policy.max_refund_offer_pct),
      reason: 'HIGH_VALUE_REQUIRES_HUMAN_REVIEW',
      rule_id: 'BR-006',
      guardrail_status: 'BLOCKED',
    };
  }

  // 2. Check Negotiation Rounds (BR-017)
  const currentRounds = context.currentRounds ?? 0;
  const roundsCheck = checkNegotiationRounds(currentRounds, policy.max_negotiation_rounds);
  if (!roundsCheck.allowed) {
    recordFirewallAuditLog({
      merchantId: context.merchantId,
      entityType: 'negotiation_sessions',
      entityId: context.sessionId ?? context.disputeId,
      action: 'MAX_ROUNDS_EXCEEDED',
      actorId: context.actorId,
      actorType: context.actorType,
      newStateJson: {
        current_rounds: currentRounds,
        max_rounds: policy.max_negotiation_rounds,
      },
      ruleIdsChecked: ['BR-017'],
      guardrailStatus: 'BLOCKED',
      ipAddress: context.ipAddress,
    }, conn);

    return {
      allowed: false,
      clamped: false,
      original_amount_cents: context.offeredCents,
      final_amount_cents: 0,
      max_allowed_cents: calculateRefundCap(context.disputeAmountCents, policy.max_refund_offer_pct),
      reason: 'MAX_ROUNDS_EXCEEDED',
      rule_id: 'BR-017',
      guardrail_status: 'BLOCKED',
    };
  }

  // 3. Check Cumulative Refund Cap (BR-014)
  if (context.orderAmountCents !== undefined && context.cumulativeRefundedCents !== undefined) {
    if (context.cumulativeRefundedCents + context.offeredCents > context.orderAmountCents) {
      const remainingAllowed = Math.max(0, context.orderAmountCents - context.cumulativeRefundedCents);
      recordFirewallAuditLog({
        merchantId: context.merchantId,
        entityType: 'settlement_offers',
        entityId: context.disputeId,
        action: 'CUMULATIVE_CAP_EXCEEDED',
        actorId: context.actorId,
        actorType: context.actorType,
        newStateJson: {
          order_amount_cents: context.orderAmountCents,
          cumulative_refunded_cents: context.cumulativeRefundedCents,
          offered_cents: context.offeredCents,
          remaining_allowed: remainingAllowed,
        },
        ruleIdsChecked: ['BR-014'],
        guardrailStatus: 'BLOCKED',
        ipAddress: context.ipAddress,
      }, conn);

      return {
        allowed: false,
        clamped: true,
        original_amount_cents: context.offeredCents,
        final_amount_cents: remainingAllowed,
        max_allowed_cents: remainingAllowed,
        reason: 'EXCEEDS_CUMULATIVE_ORDER_AMOUNT',
        rule_id: 'BR-014',
        guardrail_status: 'BLOCKED',
      };
    }
  }

  // 4. Check Settlement Refund Cap (BR-004)
  const capResult = validateSettlementOffer(
    context.disputeAmountCents,
    context.offeredCents,
    policy.max_refund_offer_pct
  );

  // Write Audit Log
  recordFirewallAuditLog({
    merchantId: context.merchantId,
    entityType: 'settlement_offers',
    entityId: context.disputeId,
    action: capResult.allowed ? 'OFFER_APPROVED' : 'FIREWALL_INTERCEPT',
    actorId: context.actorId,
    actorType: context.actorType,
    newStateJson: {
      dispute_amount_cents: context.disputeAmountCents,
      requested_offer_cents: context.offeredCents,
      final_offer_cents: capResult.final_amount_cents,
      cap_pct: policy.max_refund_offer_pct,
      clamped: capResult.clamped,
    },
    ruleIdsChecked: ['BR-004'],
    guardrailStatus: capResult.guardrail_status ?? 'PASSED',
    ipAddress: context.ipAddress,
  }, conn);

  return capResult;
}
