/**
 * ChargebackShield — Expected Value (EV) Engine
 * Grounded in PRD §6.3, BR-007, and BR-023
 */

export interface EvCalculationInput {
  winProbability: number;          // 0.0000 to 1.0000
  disputeAmountCents: number;      // Positive integer cents
  chargebackFeeCents?: number;     // e.g. 1500 cents ($15.00 default)
  opsCostCents?: number;           // e.g. 500 cents ($5.00 default)
  offeredAmountCents?: number;     // Proposed partial refund cents
  maxRefundOfferPct?: number;      // e.g. 0.40 (40% cap)
}

export interface EvEngineResult {
  evCompeteCents: number;          // Net expected value of fighting (integer cents)
  evSettleCents: number;           // Financial outflow of settlement (-offered_amount)
  evAcceptCents: number;           // Financial loss of conceding (-dispute_amount - fee)
  netRetainedCompeteCents: number; // Expected revenue preserved if fighting
  netRetainedSettleCents: number;  // Revenue preserved if settling (dispute_amount - offer)
  recommendedTrackByEv: 'COMPETE' | 'SETTLE' | 'ACCEPT';
  parameters: {
    winProbability: number;
    disputeAmountCents: number;
    chargebackFeeCents: number;
    opsCostCents: number;
    offeredAmountCents: number;
  };
}

export const DEFAULT_CHARGEBACK_FEE_CENTS = 1500; // $15.00 standard PayPal chargeback fee
export const DEFAULT_OPS_COST_CENTS = 500;        // $5.00 dispute processing cost
export const DEFAULT_MAX_REFUND_OFFER_PCT = 0.40; // 40% cap (BR-004)

/**
 * Calculates Expected Value of fighting/contesting a dispute (BR-007).
 * Formula: EV_Compete = round(W * A - (1 - W) * F - C_ops)
 */
export function calculateEvCompete(
  winProb: number,
  disputeAmountCents: number,
  chargebackFeeCents: number = DEFAULT_CHARGEBACK_FEE_CENTS,
  opsCostCents: number = DEFAULT_OPS_COST_CENTS
): number {
  if (disputeAmountCents < 0) {
    throw new Error(`Invalid dispute amount: ${disputeAmountCents}. Amount must be non-negative.`);
  }
  const w = Math.max(0, Math.min(1, winProb));
  const rawEv = (w * disputeAmountCents) - ((1 - w) * chargebackFeeCents) - opsCostCents;
  return Math.round(rawEv);
}

/**
 * Calculates Expected Value of settling via partial refund (BR-007).
 * EV_Settle = -offeredAmountCents (cash outflow).
 */
export function calculateEvSettle(offeredAmountCents: number): number {
  return -Math.abs(Math.round(offeredAmountCents));
}

/**
 * Calculates Expected Value of auto-accepting or conceding a claim (BR-007).
 * EV_Accept = -(disputeAmountCents + chargebackFeeCents)
 */
export function calculateEvAccept(
  disputeAmountCents: number,
  chargebackFeeCents: number = DEFAULT_CHARGEBACK_FEE_CENTS
): number {
  return -Math.round(disputeAmountCents + chargebackFeeCents);
}

/**
 * Calculates net revenue preserved if settling with buyer.
 * Net Retained = disputeAmountCents - offeredAmountCents
 */
export function calculateNetRetainedSettle(
  disputeAmountCents: number,
  offeredAmountCents: number
): number {
  return Math.round(disputeAmountCents - offeredAmountCents);
}

/**
 * Comprehensive EV calculation across all resolution paths.
 * Enforces BR-023 (integer cents uniformity).
 */
export function calculateAllEvs(input: EvCalculationInput): EvEngineResult {
  const {
    winProbability,
    disputeAmountCents,
    chargebackFeeCents = DEFAULT_CHARGEBACK_FEE_CENTS,
    opsCostCents = DEFAULT_OPS_COST_CENTS,
    maxRefundOfferPct = DEFAULT_MAX_REFUND_OFFER_PCT,
  } = input;

  const offeredAmountCents =
    input.offeredAmountCents !== undefined
      ? input.offeredAmountCents
      : Math.floor(disputeAmountCents * maxRefundOfferPct);

  const evCompeteCents = calculateEvCompete(winProbability, disputeAmountCents, chargebackFeeCents, opsCostCents);
  const evSettleCents = calculateEvSettle(offeredAmountCents);
  const evAcceptCents = calculateEvAccept(disputeAmountCents, chargebackFeeCents);

  const netRetainedCompeteCents = Math.round(winProbability * disputeAmountCents);
  const netRetainedSettleCents = calculateNetRetainedSettle(disputeAmountCents, offeredAmountCents);

  // Recommended track by pure financial EV
  let recommendedTrackByEv: 'COMPETE' | 'SETTLE' | 'ACCEPT';
  if (evCompeteCents >= evSettleCents && evCompeteCents >= evAcceptCents) {
    recommendedTrackByEv = 'COMPETE';
  } else if (evSettleCents >= evAcceptCents) {
    recommendedTrackByEv = 'SETTLE';
  } else {
    recommendedTrackByEv = 'ACCEPT';
  }

  return {
    evCompeteCents,
    evSettleCents,
    evAcceptCents,
    netRetainedCompeteCents,
    netRetainedSettleCents,
    recommendedTrackByEv,
    parameters: {
      winProbability,
      disputeAmountCents,
      chargebackFeeCents,
      opsCostCents,
      offeredAmountCents,
    },
  };
}
