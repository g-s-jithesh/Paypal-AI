/**
 * ChargebackShield — Firewall & Injection Defense Domain Types
 * Grounded in PROJECT.md, PRD §6.3, §8, and SPEC-SURVEY-002 §5
 */

export type GuardrailStatus = 'PASSED' | 'BLOCKED' | 'WARNING';

export interface PolicyRuleConfig {
  merchant_id: string;
  max_auto_dispute_cents: number;  // Default: 25000 ($250.00) (BR-006)
  max_refund_offer_pct: number;    // Decimal e.g. 0.40 or integer 40 (BR-004)
  min_win_prob_auto_submit: number;// Default: 0.75
  auto_accept_below_cents: number; // Default: 3500 ($35.00)
  min_win_prob_auto_accept: number;// Default: 0.35
  default_ops_cost_cents: number;  // Default: 500 ($5.00)
  max_negotiation_rounds: number;  // Default: 3 (BR-017)
  sla_buffer_hours: number;        // Default: 4 (BR-010)
}

export interface FirewallValidationResult {
  allowed: boolean;
  clamped: boolean;
  original_amount_cents: number;
  final_amount_cents: number;
  reason?: 'EXCEEDS_POLICY_CAP' | 'HIGH_VALUE_REQUIRES_HUMAN_REVIEW' | 'MAX_ROUNDS_EXCEEDED' | 'EXCEEDS_CUMULATIVE_ORDER_AMOUNT' | 'INVALID_AMOUNT' | string;
  rule_id?: 'BR-004' | 'BR-006' | 'BR-014' | 'BR-017' | string;
  guardrail_status?: GuardrailStatus;
  max_allowed_cents?: number;
}

export interface SettlementOfferContext {
  merchantId: string;
  disputeId: string;
  disputeAmountCents: number;
  offeredCents: number;
  orderAmountCents?: number;
  sessionId?: string;
  currentRounds?: number;
  cumulativeRefundedCents?: number;
  actorId?: string;
  actorType?: 'AI_AGENT' | 'SYSTEM' | 'BUYER' | 'MERCHANT_USER';
  ipAddress?: string;
}

export interface HighValueCheckResult {
  isHighValue: boolean;
  thresholdCents: number;
  disputeAmountCents: number;
  requiresHumanReview: boolean;
  recommendedStatus: 'READY_FOR_REVIEW' | 'OPEN';
  rule_id: 'BR-006';
}

export interface RoundsCheckResult {
  allowed: boolean;
  currentRounds: number;
  maxRounds: number;
  isExhausted: boolean;
  recommendedStatus?: 'READY_FOR_REVIEW' | 'SUBMITTED';
  rule_id: 'BR-017';
}

export interface AdversarialPatternMatch {
  patternName: string;
  category: 'INSTRUCTION_OVERRIDE' | 'EXTORTION_REFUND' | 'DELIMITER_ESCAPE' | 'SQL_INJECTION' | 'OBFUSCATION_BASE64' | 'ROLEPLAY_JAILBREAK';
  matchedSnippet: string;
  severity: 'HIGH' | 'CRITICAL' | 'MEDIUM';
}

export interface SanitizationResult {
  sanitizedPrompt: string;
  rawInput: string;
  cleanedInput: string;
  piiRedacted: boolean;
  redactedPiiTypes: string[];
  adversarialDetected: boolean;
  matchedPatterns: AdversarialPatternMatch[];
}

export interface FirewallInterceptionEvent {
  allowed: boolean;
  reason: string;
  blockedPattern: string;
  layer: 'LAYER_1_SANITIZER' | 'LAYER_2_BOUNDARY' | 'LAYER_3_VALIDATOR';
  ruleId?: string;
  disputeId: string;
  merchantId: string;
  sessionId?: string;
  originalAmountCents?: number;
  clampedAmountCents?: number;
  timestamp: string;
  uiAlert: {
    title: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
    badge: string;
  };
}

export interface ProposedToolCall {
  name: string;
  arguments: {
    dispute_id?: string;
    offer_amount_cents?: number;
    rationale?: string;
    [key: string]: any;
  };
}
