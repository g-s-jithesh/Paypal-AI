export interface DecisionTableInput {
  ruleId: string;
  disputeAmountCents: number;
  reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' | 'SIGNIFICANTLY_NOT_AS_DESCRIBED' | 'UNAUTHORISED' | 'OTHER';
  deliveryProof: boolean;
  deliveryStatus?: string;
  avsCvvMatch?: boolean;
  winProbability: number;
  expectedAction: 'AUTO_SUBMIT_EVIDENCE' | 'OFFER_PARTIAL_REFUND' | 'AUTO_ACCEPT_CLAIM' | 'ESCALATE_TO_HUMAN';
  expectedStatus: 'SUBMITTED' | 'NEGOTIATING' | 'SETTLED_VIA_REFUND' | 'READY_FOR_REVIEW';
  expectedTrack: 'TRACK_A_AUTO_SUBMIT' | 'TRACK_B_NEGOTIATE' | 'TRACK_C_AUTO_ACCEPT' | 'TRACK_D_HUMAN_REVIEW';
}

export const STEP_18_DECISION_MATRIX: DecisionTableInput[] = [
  // R1: High-Value Dispute (> $250.00) -> Track D
  {
    ruleId: 'R1',
    disputeAmountCents: 45000, // $450.00
    reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    deliveryProof: true,
    deliveryStatus: 'DELIVERED',
    winProbability: 0.92,
    expectedAction: 'ESCALATE_TO_HUMAN',
    expectedStatus: 'READY_FOR_REVIEW',
    expectedTrack: 'TRACK_D_HUMAN_REVIEW',
  },
  // R2: INR with Verified Delivery Proof (DELIVERED) & W >= 0.75 -> Track A
  {
    ruleId: 'R2',
    disputeAmountCents: 14500, // $145.00
    reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    deliveryProof: true,
    deliveryStatus: 'DELIVERED',
    winProbability: 0.91,
    expectedAction: 'AUTO_SUBMIT_EVIDENCE',
    expectedStatus: 'SUBMITTED',
    expectedTrack: 'TRACK_A_AUTO_SUBMIT',
  },
  // R3: INR without Delivery Proof (IN_TRANSIT) & W < 0.75 -> Track B
  {
    ruleId: 'R3',
    disputeAmountCents: 8500, // $85.00
    reasonCode: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    deliveryProof: false,
    deliveryStatus: 'IN_TRANSIT',
    winProbability: 0.32,
    expectedAction: 'OFFER_PARTIAL_REFUND',
    expectedStatus: 'NEGOTIATING',
    expectedTrack: 'TRACK_B_NEGOTIATE',
  },
  // R4: SNAD with Moderate Win Prob (0.35 to 0.74) -> Track B
  {
    ruleId: 'R4',
    disputeAmountCents: 12000, // $120.00
    reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
    deliveryProof: true,
    winProbability: 0.55,
    expectedAction: 'OFFER_PARTIAL_REFUND',
    expectedStatus: 'NEGOTIATING',
    expectedTrack: 'TRACK_B_NEGOTIATE',
  },
  // R5: SNAD with Overwhelming Evidence & Usage Logs & W >= 0.75 -> Track A
  {
    ruleId: 'R5',
    disputeAmountCents: 11000, // $110.00
    reasonCode: 'SIGNIFICANTLY_NOT_AS_DESCRIBED',
    deliveryProof: true,
    winProbability: 0.82,
    expectedAction: 'AUTO_SUBMIT_EVIDENCE',
    expectedStatus: 'SUBMITTED',
    expectedTrack: 'TRACK_A_AUTO_SUBMIT',
  },
  // R6: Low-Value Dispute (<= $35.00) & W < 0.35 & Negative EV -> Track C
  {
    ruleId: 'R6',
    disputeAmountCents: 2800, // $28.00
    reasonCode: 'UNAUTHORISED',
    deliveryProof: false,
    winProbability: 0.20,
    expectedAction: 'AUTO_ACCEPT_CLAIM',
    expectedStatus: 'SETTLED_VIA_REFUND',
    expectedTrack: 'TRACK_C_AUTO_ACCEPT',
  },
  // R7: UNAUTHORISED with AVS/CVV Match + IP Match & W >= 0.75 -> Track A
  {
    ruleId: 'R7',
    disputeAmountCents: 18000, // $180.00
    reasonCode: 'UNAUTHORISED',
    deliveryProof: true,
    avsCvvMatch: true,
    winProbability: 0.88,
    expectedAction: 'AUTO_SUBMIT_EVIDENCE',
    expectedStatus: 'SUBMITTED',
    expectedTrack: 'TRACK_A_AUTO_SUBMIT',
  },
  // R8: UNAUTHORISED with Missing AVS/IP & W < 0.75 -> Track D
  {
    ruleId: 'R8',
    disputeAmountCents: 18000, // $180.00
    reasonCode: 'UNAUTHORISED',
    deliveryProof: false,
    avsCvvMatch: false,
    winProbability: 0.40,
    expectedAction: 'ESCALATE_TO_HUMAN',
    expectedStatus: 'READY_FOR_REVIEW',
    expectedTrack: 'TRACK_D_HUMAN_REVIEW',
  },
];

/**
 * Calculates EV Compete in integer cents (BR-007)
 */
export function calculateEvCompete(
  winProb: number,
  amountCents: number,
  feeCents: number = 1500,
  opsCostCents: number = 500
): number {
  return Math.round(winProb * amountCents - (1 - winProb) * feeCents - opsCostCents);
}

/**
 * Decision Engine Router evaluating Step 18 rules
 */
export function routeStep18(input: {
  disputeAmountCents: number;
  reasonCode: string;
  deliveryProof: boolean;
  deliveryStatus?: string;
  avsCvvMatch?: boolean;
  winProbability: number;
  maxAutoDisputeCents?: number;
  autoAcceptBelowCents?: number;
}): {
  action: 'AUTO_SUBMIT_EVIDENCE' | 'OFFER_PARTIAL_REFUND' | 'AUTO_ACCEPT_CLAIM' | 'ESCALATE_TO_HUMAN';
  status: 'SUBMITTED' | 'NEGOTIATING' | 'SETTLED_VIA_REFUND' | 'READY_FOR_REVIEW';
  track: 'TRACK_A_AUTO_SUBMIT' | 'TRACK_B_NEGOTIATE' | 'TRACK_C_AUTO_ACCEPT' | 'TRACK_D_HUMAN_REVIEW';
  ruleId: string;
} {
  const maxAuto = input.maxAutoDisputeCents ?? 25000;
  const autoAcceptCeiling = input.autoAcceptBelowCents ?? 3500;

  // R1: High-Value Dispute Gate (> $250.00)
  if (input.disputeAmountCents > maxAuto) {
    return {
      action: 'ESCALATE_TO_HUMAN',
      status: 'READY_FOR_REVIEW',
      track: 'TRACK_D_HUMAN_REVIEW',
      ruleId: 'R1',
    };
  }

  // R6: Low-Value Auto-Accept Gate (<= $35.00 & W < 0.35 & Negative EV)
  const ev = calculateEvCompete(input.winProbability, input.disputeAmountCents);
  if (input.disputeAmountCents <= autoAcceptCeiling && input.winProbability < 0.35 && ev < 0) {
    return {
      action: 'AUTO_ACCEPT_CLAIM',
      status: 'SETTLED_VIA_REFUND',
      track: 'TRACK_C_AUTO_ACCEPT',
      ruleId: 'R6',
    };
  }

  // Reason: INR
  if (input.reasonCode === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    if (input.deliveryProof && input.deliveryStatus === 'DELIVERED' && input.winProbability >= 0.75) {
      return {
        action: 'AUTO_SUBMIT_EVIDENCE',
        status: 'SUBMITTED',
        track: 'TRACK_A_AUTO_SUBMIT',
        ruleId: 'R2',
      };
    }
    return {
      action: 'OFFER_PARTIAL_REFUND',
      status: 'NEGOTIATING',
      track: 'TRACK_B_NEGOTIATE',
      ruleId: 'R3',
    };
  }

  // Reason: SNAD
  if (input.reasonCode === 'SIGNIFICANTLY_NOT_AS_DESCRIBED') {
    if (input.winProbability >= 0.75 && input.deliveryProof) {
      return {
        action: 'AUTO_SUBMIT_EVIDENCE',
        status: 'SUBMITTED',
        track: 'TRACK_A_AUTO_SUBMIT',
        ruleId: 'R5',
      };
    }
    return {
      action: 'OFFER_PARTIAL_REFUND',
      status: 'NEGOTIATING',
      track: 'TRACK_B_NEGOTIATE',
      ruleId: 'R4',
    };
  }

  // Reason: UNAUTHORISED
  if (input.reasonCode === 'UNAUTHORISED') {
    if (input.avsCvvMatch && input.winProbability >= 0.75) {
      return {
        action: 'AUTO_SUBMIT_EVIDENCE',
        status: 'SUBMITTED',
        track: 'TRACK_A_AUTO_SUBMIT',
        ruleId: 'R7',
      };
    }
    return {
      action: 'ESCALATE_TO_HUMAN',
      status: 'READY_FOR_REVIEW',
      track: 'TRACK_D_HUMAN_REVIEW',
      ruleId: 'R8',
    };
  }

  // Default fallback to Human Review
  return {
    action: 'ESCALATE_TO_HUMAN',
    status: 'READY_FOR_REVIEW',
    track: 'TRACK_D_HUMAN_REVIEW',
    ruleId: 'DEFAULT_FALLBACK',
  };
}
