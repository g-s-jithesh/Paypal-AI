## 2026-11-02T11:12:27Z
Working directory: C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\explorer_m2_1
Read ORIGINAL_REQUEST.md: C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\ORIGINAL_REQUEST.md
Read PROJECT.md: C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\PROJECT.md
Read Spec Report 1: C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\spec_miner_survey_1\spec_report.md

You are explorer_m2_1 (teamwork_explorer).
Scope: Milestone 2 — AI Win Probability Engine, Expected Value (EV) Engine & Step 18 Decision Table Router (`lib/engine/*`).
Your Task:
Investigate and design the exact technical implementation plan for:
1. `lib/engine/win-probability.ts`:
   - Feature weights: delivery proof (+0.45), carrier tracking confirmed (+0.25), prior chargeback history (-0.30), buyer account age > 1 yr (+0.10), merchant refund policy accepted (+0.10), reason code base weights (INR: 0.50, SNAD: 0.35, UNAUTHORISED: 0.25).
   - Bounds: strictly clamped between 0.0000 and 1.0000 (`BR-003`).
   - Factor extraction from `orders`, `evidence_items`, `disputes`.
2. `lib/engine/ev-engine.ts`:
   - Exact mathematical implementation of BR-007:
     - $EV_{Compete} = (W \times \text{dispute\_amount}) - ((1 - W) \times \text{chargeback\_fee}) - \text{ops\_cost}$
     - $EV_{Settle} = -\text{offered\_amount}$
     - $EV_{Accept} = -\text{dispute\_amount} - \text{chargeback\_fee}$
   - Integer cents precision (`BR-023`).
3. `lib/engine/decision-router.ts`:
   - Exhaustive implementation of Step 18 Decision Table R1 through R8 (`BR-016`):
     - R1: Dispute amount > $250.00 (`BR-006`) -> `ESCALATE_TO_HUMAN` (Track D, status: `READY_FOR_REVIEW`)
     - R2: INR with delivery proof & $W \ge 0.75$ -> `AUTO_SUBMIT_EVIDENCE` (Track A, status: `SUBMITTED`)
     - R3: INR without delivery proof -> `OFFER_PARTIAL_REFUND` (Track B, status: `NEGOTIATING`)
     - R4: SNAD without proof -> `OFFER_PARTIAL_REFUND` (Track B, status: `NEGOTIATING`)
     - R5: SNAD with proof & $W \ge 0.75$ -> `AUTO_SUBMIT_EVIDENCE` (Track A, status: `SUBMITTED`)
     - R6: Dispute amount <= $35.00 with negative EV & $W < 0.35$ (`BR-017`) -> `AUTO_ACCEPT_CLAIM` (Track C, status: `SETTLED_VIA_REFUND`)
     - R7: UNAUTHORISED with AVS/CVV match & $W \ge 0.75$ -> `AUTO_SUBMIT_EVIDENCE` (Track A, status: `SUBMITTED`)
     - R8: Other / fallback -> `ESCALATE_TO_HUMAN` (Track D, status: `READY_FOR_REVIEW`)
   - Returns structured `DecisionResult` with action, track, nextStatus, ruleId, rationale, ev, winProb.
   - Persistence helper: updates `disputes.status`, inserts `ai_assessments` (`ENT-05`), and logs `audit_logs` (`ENT-09`).

Write your detailed plan in `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\explorer_m2_1\plan.md` and handoff report in `handoff.md`. Update `progress.md`. Send a message when complete.
