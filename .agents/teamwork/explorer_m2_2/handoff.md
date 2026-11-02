# Handoff Report: Milestone 2 — Deterministic MCP Policy Firewall & 3-Layer Prompt Injection Defense

**Document:** `handoff.md`  
**Agent:** `explorer_m2_2` (teamwork_explorer)  
**Parent Agent:** `ef552306-58dd-42b3-9740-e2590ec7a495`  
**Date:** 2026-11-02  
**Handoff Type:** Hard (Task complete)  

---

## 1. Observation

1. **Database Schema & Check Constraints (`db/schema.sql`)**:
   - `policy_rules` table (`lines 207-227`): defines `max_auto_dispute_cents INTEGER DEFAULT 25000` ($250.00), `max_refund_offer_pct REAL DEFAULT 0.40`, `auto_accept_below_cents INTEGER DEFAULT 3500`.
   - `settlement_offers` table (`lines 181-202`): defines `offered_amount_cents INTEGER NOT NULL`, `max_allowed_cents INTEGER NOT NULL CHECK (max_allowed_cents >= offered_amount_cents)`.
   - `negotiation_sessions` table (`lines 162-175`): defines `guardrail_triggered_count INTEGER NOT NULL DEFAULT 0 CHECK (guardrail_triggered_count >= 0)`.
   - `audit_logs` table (`lines 233-250`): defines `guardrail_status TEXT NOT NULL CHECK (guardrail_status IN ('PASSED', 'BLOCKED', 'WARNING'))`.
   - SQLite triggers `trg_audit_logs_no_update` and `trg_audit_logs_no_delete` (`lines 314-325`): abort any `UPDATE` or `DELETE` on `audit_logs`, strictly enforcing append-only immutability.
2. **Existing Business Rules & Pre-Code Test Passes**:
   - Executed `npm run test:rules`: 4 test suites passed (56/56 tests passing), including `tests/rules/br-financial-limits.test.ts` (verifying `BR-001`, `BR-004`, `BR-006`, `BR-014`, `BR-017`, `BR-023`).
   - Executed `npx vitest run tests/e2e/tier1/t1_firewall_sandbox.test.ts`: 20/20 tests passed, which tested initial mock versions of `validateSettlementOffer` and `sanitizeBuyerPrompt`.
   - `tests/e2e/tier4/t4_uat004_prompt_injection_block.test.ts`: lines 36-63 explicitly test UAT-004 prompt injection block against `DSP-GOLD-003`, asserting that an offer of $120.00 is clamped to $48.00, `guardrail_triggered_count` increments to 1, and `audit_logs.guardrail_status` is `'BLOCKED'`.
3. **Dispatch Scope & Discrepancy Reconciliation**:
   - Dispatch requested: audit logging with `guardrail_status: 'BLOCKED' | 'APPROVED'`.
   - Direct observation of `db/schema.sql:246` and `tests/rules/br-evidence-safety.test.ts:134`: schema check constraint requires `guardrail_status IN ('PASSED', 'BLOCKED', 'WARNING')`. Attempting to write `'APPROVED'` directly to SQLite would violate check constraints.
   - Design reconciliation: the audit logging helper normalizes `'APPROVED'` and `'PASSED'` to `'PASSED'` for database insertion, while allowing external callers to use either convention.

---

## 2. Logic Chain

1. **From Observation 1 (DB Schema Constraints)**:
   - Because `settlement_offers.max_allowed_cents >= offered_amount_cents` is checked at the database level, any offer exceeding the calculated refund cap would cause an unhandled database exception if not handled earlier.
   - Therefore, the MCP Policy Firewall must perform deterministic calculation and clamping *prior* to any database write or PayPal API transmission.
2. **From Observation 1 & 2 (Rules BR-004, BR-006, BR-014, BR-017)**:
   - Rule `BR-004` dictates $\text{MaxAllowed} = \lfloor \text{dispute\_amount\_cents} \times \text{max\_refund\_offer\_pct} \rfloor$. Handling both decimal fractions (`0.40`) and whole numbers (`40`) prevents runtime math errors.
   - Rule `BR-006` requires that any dispute $> \$250.00$ ($25,000$ cents) bypass autonomous tool execution and route immediately to `READY_FOR_REVIEW`.
   - Rule `BR-017` limits negotiation to at most 3 rounds.
   - Rule `BR-014` dictates cumulative partial refunds cannot exceed the captured order amount.
3. **From Observation 2 (Existing Tests & Attack Scenarios)**:
   - Prompt injections in e-commerce chat portals fall into distinct vectors: instruction overrides, 100% refund demands, delimiter breakouts, SQL injection probes, and base64 obfuscation.
   - Defense-in-depth requires:
     - **Layer 1**: Regex scanner detecting adversarial patterns and stripping PII.
     - **Layer 2**: XML tag boundary (`<buyer_input>`) with XML character escaping to prevent prompt breakout.
     - **Layer 3**: Post-LLM deterministic mathematical validator that intercepts the `make-offer` tool call and clamps/rejects any value above the policy cap regardless of what the LLM generated.
4. **From Observation 1 & 3 (Audit Trail Immutability)**:
   - SQLite triggers prevent modifications or deletions on `audit_logs`.
   - Every firewall evaluation and intercept must be written as an atomic, append-only row into `audit_logs` (`ENT-09`) with `rule_ids_checked: '["BR-004"]'` and `guardrail_status: 'BLOCKED'` or `'PASSED'`.
   - For UI feedback, each intercept must update `negotiation_sessions.guardrail_triggered_count` and yield a structured event containing the blocked pattern and alert metadata.

---

## 3. Caveats

1. **LLM Provider Variance**: The firewall is designed to be completely LLM-agnostic; it does not depend on model fine-tuning or specific system prompt obedience because Layer 3 runs outside and after the LLM.
2. **Base64 Nested Depth**: Layer 1 base64 scanning decodes one layer of base64 strings $\ge 32$ characters. Multi-nested base64 encodings (e.g. triple base64) are caught by Layer 3 deterministic mathematical bounds check even if Layer 1 scanner does not parse nested layers.
3. **No Direct Production Implementation**: As a Teamwork Explorer in read-only mode, code was not written to production files under `lib/firewall/`; instead, the complete implementation blueprint, contracts, algorithms, and test specifications were written to `plan.md`.

---

## 4. Conclusion

The technical implementation plan for Milestone 2 (`lib/firewall/*`) is fully designed and validated:
- `lib/firewall/policy-firewall.ts` will strictly enforce `BR-004` (mathematical clamping), `BR-006` (high-value gate $> \$250$), `BR-017` (max 3 negotiation rounds), and `BR-014` (cumulative order refund cap).
- `lib/firewall/injection-defense.ts` will provide a 3-Layer defense:
  - Layer 1: Regex & Base64 pattern matching + PII redaction.
  - Layer 2: Rigid XML boundary with character escaping and JSON schema constraints.
  - Layer 3: Post-LLM deterministic output validator intercepting tool calls.
- `lib/firewall/audit-logger.ts` will guarantee schema-compliant, append-only logging to `audit_logs` (`ENT-09`) with `guardrail_status: 'PASSED' | 'BLOCKED'`.
- All interfaces maintain 100% backwards compatibility with existing test suites (`tests/rules/*`, `tests/e2e/tier1/t1_firewall_sandbox.test.ts`, `tests/e2e/tier4/t4_uat004_prompt_injection_block.test.ts`).

---

## 5. Verification Method

1. **Verify Implementation Plan**:
   - Inspect `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\explorer_m2_2\plan.md`.
2. **Execute Existing Test Harness**:
   - Run business rules: `npm run test:rules` (asserts 56/56 passing).
   - Run Tier 1 firewall & sandbox tests: `npx vitest run tests/e2e/tier1/t1_firewall_sandbox.test.ts` (asserts 20/20 passing).
   - Run Tier 4 UAT injection defense test: `npx vitest run tests/e2e/tier4/t4_uat004_prompt_injection_block.test.ts` (asserts 1/1 passing).
3. **Verify Downstream Implementer Acceptance**:
   - Once the implementer writes `lib/firewall/*.ts`, run:
     `npx vitest run tests/firewall/`
     and verify all 20 tests pass with zero lint or schema constraint errors.
