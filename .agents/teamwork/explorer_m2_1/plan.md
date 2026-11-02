# Milestone 2 Technical Implementation Plan: Core Decision Engine (`lib/engine/*`)

**Target Modules**:
1. `lib/engine/win-probability.ts` (Feature 8, PRD §6.4, BR-003)
2. `lib/engine/ev-engine.ts` (Feature 9, PRD §6.3, BR-007, BR-023)
3. `lib/engine/decision-router.ts` (Feature 10, PRD §6.4, BR-006, BR-016, BR-017, ENT-03/05/09)
4. `lib/engine/index.ts` (Unified export barrel & facade)

---

## 1. System Context & Architectural Flow

```
                     ┌───────────────────────────────┐
                     │ Inbound Dispute / DB Record   │
                     │  (disputes, orders, evidence) │
                     └───────────────┬───────────────┘
                                     │
                                     ▼
               ┌───────────────────────────────────────────┐
               │ 1. Factor Extractor & Win Probability     │
               │    lib/engine/win-probability.ts          │
               │  • Base weight by reason code             │
               │  • Feature weights (+0.45, +0.25, etc.)   │
               │  • Strictly clamped [0.0000, 1.0000]      │
               └─────────────────────┬─────────────────────┘
                                     │ Win Probability (W)
                                     ▼
               ┌───────────────────────────────────────────┐
               │ 2. Expected Value (EV) Engine             │
               │    lib/engine/ev-engine.ts                │
               │  • EV_Compete = W*A - (1-W)*F - C_ops     │
               │  • EV_Settle = -OfferedAmount             │
               │  • EV_Accept = -DisputeAmount - Fee       │
               │  • Integer cents precision (BR-023)       │
               └─────────────────────┬─────────────────────┘
                                     │ W, EV_Compete, EV_Settle, EV_Accept
                                     ▼
               ┌───────────────────────────────────────────┐
               │ 3. Step 18 Decision Table Router          │
               │    lib/engine/decision-router.ts          │
               │  • R1: High-Value Gate (> $250.00)        │
               │  • R6: Auto-Accept Ceiling (<= $35, W<0.35│
               │        and EV_Compete < 0)                │
               │  • R2/R3: INR (Proof + W>=0.75 vs missing)│
               │  • R5/R4: SNAD (Proof + W>=0.75 vs缺少)   │
               │  • R7/R8: UNAUTHORISED (AVS/CVV vs missing│
               │  • R8: Ambiguous / Fallback to Track D    │
               └─────────────────────┬─────────────────────┘
                                     │ DecisionResult
                                     ▼
               ┌───────────────────────────────────────────┐
               │ 4. Transactional Persistence Helper       │
               │    (disputes, ai_assessments, audit_logs) │
               │  • Atomic runTransaction()                │
               │  • Optimistic locking (version + 1)       │
               │  • Append-only tamper-evident audit ledger│
               └───────────────────────────────────────────┘
```

---

## 2. Module Specifications

### 2.1 `lib/engine/win-probability.ts`

#### Responsibilities:
- Computes empirical and heuristic AI Win Probability score $W \in [0.0000, 1.0000]$ (`BR-003`).
- Applies base reason code priors:
  - `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` (INR): `0.50`
  - `SIGNIFICANTLY_NOT_AS_DESCRIBED` (SNAD): `0.35`
  - `UNAUTHORISED`: `0.25`
  - `CANCELLED_RECURRING_BILLING`: `0.30`
  - `OTHER`: `0.25`
- Evaluates specific feature delta weights:
  - Delivery proof verified (`+0.45`)
  - Carrier tracking confirmed (`+0.25`)
  - Prior chargeback history (`-0.30`)
  - Buyer account age > 1 year (`+0.10`)
  - Merchant refund policy accepted (`+0.10`)
- Enforces strict floating-point bounding:
  $$\text{clamp}(x, 0.0000, 1.0000) = \max(0.0000, \min(1.0000, \text{round}(x \times 10000) / 10000))$$
- Extracts ground truth factors from `orders`, `evidence_items`, and `disputes`.

#### TypeScript Interfaces:
```typescript
import { DisputeReasonCode, DeliveryStatus } from '../contracts';

export interface WinProbabilityFactors {
  reasonCode: DisputeReasonCode | string;
  hasDeliveryProof?: boolean;
  hasCarrierTrackingConfirmed?: boolean;
  hasPriorChargebackHistory?: boolean;
  isBuyerAccountAgeGt1Yr?: boolean;
  isMerchantRefundPolicyAccepted?: boolean;
  // Domain context metadata
  hasAvsCvvMatch?: boolean;
  hasUsageLogs?: boolean;
}

export interface FactorBreakdownItem {
  factor: keyof WinProbabilityFactors | 'BASE_REASON_CODE';
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
```

#### Factor Extraction Logic:
1. **Delivery Proof (`hasDeliveryProof`)**:
   - Evaluated as `true` if:
     - `orders.delivery_status === 'DELIVERED'` OR `orders.delivered_at IS NOT NULL` OR `orders.delivery_signature_name IS NOT NULL`
     - OR `evidence_items` contains verified item (`is_verified = 1`) with `evidence_type IN ('TRACKING_PROOF', 'DELIVERY_SIGNATURE')`.
2. **Carrier Tracking Confirmed (`hasCarrierTrackingConfirmed`)**:
   - Evaluated as `true` if:
     - `orders.tracking_number` is non-null and non-empty
     - `orders.carrier_name` is non-null and non-empty
     - `orders.delivery_status IN ('SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED')`
     - OR `evidence_items` has verified `TRACKING_PROOF`.
3. **Prior Chargeback History (`hasPriorChargebackHistory`)**:
   - Evaluated as `true` if:
     ```sql
     SELECT COUNT(*) AS count
     FROM disputes d
     JOIN orders o ON d.order_id = o.id
     WHERE (o.customer_id = :customerId OR o.customer_email = :customerEmail)
       AND d.id != :currentDisputeId;
     ```
     `count > 0`.
4. **Buyer Account Age > 1 Year (`isBuyerAccountAgeGt1Yr`)**:
   - Evaluated as `true` if:
     ```sql
     SELECT MIN(created_at) AS earliest_order
     FROM orders
     WHERE customer_id = :customerId OR customer_email = :customerEmail;
     ```
     `(currentOrderTime - earliestOrderTime) > (365 * 24 * 60 * 60 * 1000) ms`
     OR `evidence_items` content contains verified `account_age_days > 365`.
5. **Merchant Refund Policy Accepted (`isMerchantRefundPolicyAccepted`)**:
   - Evaluated as `true` if:
     - `evidence_items` contains verified item (`is_verified = 1`) with `evidence_type = 'REFUND_POLICY'`
     - OR order checkout logs confirm terms & conditions acceptance.
6. **AVS/CVV & Usage Logs (Context Flags)**:
   - Extracted from `evidence_items` content JSON (`evidence_type IN ('ORDER_RECEIPT', 'ACCESS_LOGS', 'USAGE_LOG')`).

#### Key Exported Functions:
- `calculateWinProbability(factors: WinProbabilityFactors): WinProbabilityResult` (Pure function)
- `extractWinProbabilityFactors(db: Database, disputeId: string): WinProbabilityFactors` (DB extractor)
- `assessWinProbability(db: Database, disputeId: string): WinProbabilityResult` (End-to-end analyzer)

---

### 2.2 `lib/engine/ev-engine.ts`

#### Responsibilities:
- Implements exact mathematical formulas for Expected Value (`BR-007`):
  1. **Fighting / Competing ($EV_{Compete}$)**:
     $$EV_{Compete} = \text{round}\Big((W \times \text{dispute\_amount\_cents}) - \big((1 - W) \times \text{chargeback\_fee\_cents}\big) - \text{ops\_cost\_cents}\Big)$$
  2. **Pre-Escalation Settlement ($EV_{Settle}$)**:
     $$EV_{Settle} = -\text{offered\_amount\_cents}$$
     *(Note: Net preserved merchant cash flow is $\text{dispute\_amount\_cents} - \text{offered\_amount\_cents}$)*
  3. **Auto-Accepting Claim ($EV_{Accept}$)**:
     $$EV_{Accept} = -(\text{dispute\_amount\_cents} + \text{chargeback\_fee\_cents})$$
- Strictly guarantees integer cents precision (`BR-023`) via `Math.round()` with zero floating-point accumulation.
- Fallback defaults:
  - `chargebackFeeCents`: `1500` ($15.00) if not specified by merchant
  - `opsCostCents`: `500` ($5.00) if not specified by merchant policy
  - `maxRefundOfferPct`: `0.40` (40% cap, `BR-004`)
  - `defaultOfferedAmountCents`: $\lfloor \text{disputeAmountCents} \times \text{maxRefundOfferPct} \rfloor$

#### TypeScript Interfaces:
```typescript
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
```

#### Key Exported Functions:
- `calculateEvCompete(winProb: number, amountCents: number, feeCents?: number, opsCostCents?: number): number`
- `calculateEvSettle(offeredAmountCents: number): number`
- `calculateEvAccept(amountCents: number, feeCents?: number): number`
- `calculateNetRetainedSettle(amountCents: number, offeredAmountCents: number): number`
- `calculateAllEvs(input: EvCalculationInput): EvEngineResult`

---

### 2.3 `lib/engine/decision-router.ts`

#### Responsibilities:
- Evaluates the dispute against the prioritized Step 18 Decision Matrix (`BR-016`).
- Enforces strict rule evaluation order:

| Order | Rule ID | Condition | Autonomous Action | Assigned Track | Next Status | Rule Reference |
|:---:|:---:|:---|:---|:---|:---|:---|
| **1** | **R1** | `disputeAmountCents > maxAutoDisputeCents` ($250.00) | `ESCALATE_TO_HUMAN` | `TRACK_D_HUMAN_REVIEW` | `READY_FOR_REVIEW` | `BR-006` High-Value Gate |
| **2** | **R6** | `disputeAmountCents <= autoAcceptBelowCents` ($35.00) AND $W < 0.35$ AND $EV_{Compete} < 0$ | `AUTO_ACCEPT_CLAIM` | `TRACK_C_AUTO_ACCEPT` | `SETTLED_VIA_REFUND` | `BR-017` Low-Value Auto-Accept |
| **3** | **R2** | `reasonCode === 'INR'` AND `deliveryProof === true` AND $W \ge 0.75$ | `AUTO_SUBMIT_EVIDENCE` | `TRACK_A_AUTO_SUBMIT` | `SUBMITTED` | Track A High-Confidence |
| **4** | **R3** | `reasonCode === 'INR'` AND (`!deliveryProof` OR $W < 0.75$) | `OFFER_PARTIAL_REFUND` | `TRACK_B_NEGOTIATE` | `NEGOTIATING` | `BR-009` Mandatory Proof Guard |
| **5** | **R5** | `reasonCode === 'SNAD'` AND `verifiedProof === true` AND $W \ge 0.75$ | `AUTO_SUBMIT_EVIDENCE` | `TRACK_A_AUTO_SUBMIT` | `SUBMITTED` | Track A Item Specs & Usage Logs |
| **6** | **R4** | `reasonCode === 'SNAD'` AND (`!verifiedProof` OR $W < 0.75$) | `OFFER_PARTIAL_REFUND` | `TRACK_B_NEGOTIATE` | `NEGOTIATING` | `BR-022` SNAD Negotiation |
| **7** | **R7** | `reasonCode === 'UNAUTHORISED'` AND `avsCvvMatch === true` AND $W \ge 0.75$ | `AUTO_SUBMIT_EVIDENCE` | `TRACK_A_AUTO_SUBMIT` | `SUBMITTED` | `BR-021` Fraud Match Guard |
| **8** | **R8** | `reasonCode === 'UNAUTHORISED'` AND (`!avsCvvMatch` OR $W < 0.75$) OR any unhandled / ambiguous case | `ESCALATE_TO_HUMAN` | `TRACK_D_HUMAN_REVIEW` | `READY_FOR_REVIEW` | Track D Fallback Gate |

#### TypeScript Interfaces:
```typescript
import { RecommendedAction, ResolutionTrack, DisputeStatus, DisputeReasonCode } from '../contracts';

export type DecisionRuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';

export interface DecisionRouterInput {
  disputeAmountCents: number;
  reasonCode: DisputeReasonCode | string;
  winProbability: number;
  evCompeteCents: number;
  evSettleCents?: number;
  deliveryProof: boolean;
  deliveryStatus?: string;
  avsCvvMatch?: boolean;
  hasUsageLogs?: boolean;
  maxAutoDisputeCents?: number;    // default 25000 cents ($250.00)
  autoAcceptBelowCents?: number;   // default 3500 cents ($35.00)
  minWinProbAutoSubmit?: number;   // default 0.75
  minWinProbAutoAccept?: number;   // default 0.35
}

export interface DecisionResult {
  action: RecommendedAction;
  track: ResolutionTrack;
  nextStatus: DisputeStatus;
  ruleId: DecisionRuleId;
  rationale: string;
  evCompeteCents: number;
  evSettleCents: number;
  winProbability: number;
}
```

---

### 2.4 Transactional Persistence Helper (`persistDecisionResult`)

#### Responsibilities:
- Operates strictly inside an atomic transaction using `runTransaction` (`lib/db.ts`).
- Guarantees `BR-005` (terminal status immutability):
  - If dispute is already in `('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')`, rejects execution before calling DB.
- Updates `disputes`:
  ```sql
  UPDATE disputes
  SET status = :nextStatus,
      track = :track,
      submitted_at = CASE WHEN :action = 'AUTO_SUBMIT_EVIDENCE' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE submitted_at END,
      resolved_at = CASE WHEN :nextStatus IN ('SETTLED_VIA_REFUND', 'WON', 'LOST', 'EXPIRED') THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE resolved_at END,
      version = version + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = :disputeId AND version = :currentVersion;
  ```
  *(Throws concurrency conflict exception if row count is 0, satisfying `BR-015`).*
- Inserts `ai_assessments` (`ENT-05`):
  ```sql
  INSERT INTO ai_assessments (
    id, dispute_id, win_probability, expected_value_cents, ev_settle_cents,
    recommended_action, confidence_score, reasoning_json, model_version,
    prompt_tokens, completion_tokens, execution_latency_ms, created_at
  ) VALUES (
    :id, :disputeId, :winProbability, :expectedValueCents, :evSettleCents,
    :recommendedAction, :confidenceScore, :reasoningJson, :modelVersion,
    NULL, NULL, :latencyMs, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
  ```
- Inserts `audit_logs` (`ENT-09`):
  ```sql
  INSERT INTO audit_logs (
    id, merchant_id, entity_type, entity_id, action, actor_id, actor_type,
    previous_state_json, new_state_json, rule_ids_checked, guardrail_status,
    ip_address, created_at
  ) VALUES (
    :id, :merchantId, 'disputes', :disputeId, :auditAction, :actorId, 'AI_AGENT',
    :previousStateJson, :newStateJson, :ruleIdsCheckedJson, 'PASSED',
    '127.0.0.1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
  ```

---

## 3. Boundary & Error Handling Specifications

1. **Monetary Integer Bounds (`BR-023`)**:
   - `dispute_amount_cents <= 0`: Throws `InvalidDisputeAmountError`.
   - `chargeback_fee_cents < 0`: Clamped or throws error.
   - All EV outputs passed through `Math.round(...)` to guarantee SQLite `INTEGER` storage without float truncation.
2. **Probability Bounds (`BR-003`)**:
   - $W$ calculation must never produce `NaN` or `Infinity`.
   - Strictly bounded between `0.0000` and `1.0000` rounded to 4 decimals.
3. **Optimistic Locking (`BR-015`)**:
   - Updates to `disputes` assert `version = expectedVersion`.
   - If a concurrent worker updated the dispute, throws `OptimisticLockError`.
4. **Terminal State Immutability (`BR-005`)**:
   - Any attempt to route or re-route a dispute in `WON`, `LOST`, `SETTLED_VIA_REFUND`, or `EXPIRED` status is blocked before database execution.
5. **Fall-through Safety (`BR-016`)**:
   - Any unhandled reason code or unexpected input defaults to `R8: ESCALATE_TO_HUMAN` (Track D).

---

## 4. Test Verification Plan

### Test Suites to Add / Run:
1. `tests/rules/br-decision-engine.test.ts`:
   - Verify that all 16 existing tests pass cleanly when integrated with `lib/engine/*`.
2. `tests/adversarial/boundary-decision-engine.test.ts`:
   - Verify all exact boundary tests pass:
     - Boundary 1: $250.00 vs $250.01
     - Boundary 2: $35.00 vs $35.01 with $W=0.20$ and negative EV
     - Boundary 3: $W=0.7500$ vs $W=0.7499$ across INR, SNAD, UNAUTHORISED
3. `tests/e2e/tier1/t1_core_engines.test.ts`:
   - Verify Features 8, 9, 10 pass all 15 tests.
4. `tests/e2e/tier3/t3_webhook_to_decision.test.ts`:
   - Verify end-to-end integration from webhook payload to decision persistence and audit logging.
