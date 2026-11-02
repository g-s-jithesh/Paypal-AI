# Milestone 2 Handoff Report: Dual-Mode PayPal Sandbox & API Route Handlers

**Document ID:** `HANDOFF-M2-003`  
**Author:** `explorer_m2_3` (teamwork_explorer)  
**Date:** 2026-11-02T11:23:00Z  
**Recipient:** `ef552306-58dd-42b3-9740-e2590ec7a495` (Orchestrator) / Implementation Worker  

---

## 1. Observation

1. **Workspace Directories & Existing Files:**
   - `lib/paypal` (`C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\lib\paypal`) exists and is currently empty (`sizeBytes: 0, children: 0`).
   - `app/api` (`C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\app\api`) exists with subdirectories `demo`, `disputes`, `kpis`, `negotiate`, `webhooks`, but contains zero implementation files.
   - `next.config.js` lines 1–12 configures `serverExternalPackages: ['better-sqlite3']`, enabling native C++ SQLite bindings within Next.js App Router server endpoints without bundler corruption.
   - `package.json` line 23 specifies Next.js `"next": "^15.1.7"`. Under Next.js 15, dynamic route handler parameters (`{ params }`) are Promises and require `await params`.

2. **Database Foundation & Scripts:**
   - `db/schema.sql` defines all 10 core entities (`ENT-01` to `ENT-10`):
     - `disputes` (`ENT-03`): `dispute_amount_cents`, `reason_code`, `status`, `stage`, `track`, `version`.
     - `evidence_items` (`ENT-04`): `sha256_hash`, `content_json`, `is_verified`.
     - `ai_assessments` (`ENT-05`): `win_probability`, `expected_value_cents`, `ev_settle_cents`, `recommended_action`.
     - `negotiation_sessions` (`ENT-06`): `max_refund_allowed_cents`, `guardrail_triggered_count`.
     - `settlement_offers` (`ENT-07`): `offered_amount_cents`, `max_allowed_cents`, `status`.
     - `audit_logs` (`ENT-09`): append-only triggers (`trg_audit_logs_no_update`, `trg_audit_logs_no_delete`).
     - `webhook_events` (`ENT-10`): unique constraint on `webhook_id`, indexing on `idx_webhooks_webhook_id`.
   - `scripts/seed.ts` exports `runGoldenSeeder()`, which seeds 50 disputes (`DSP-GOLD-001` .. `DSP-GOLD-005` plus 45 others) deterministically in $< 500\text{ms}$.

3. **Current Test Status:**
   - `npm run test:dq`: 5 files passed, 18 tests passed (100% Data Quality Score).
   - `npm run test:rules`: 4 files passed, 56 tests passed (100% Rules Pass, BR-001 through BR-025).
   - `npm run test:nfr`: 3 files passed, 7 tests passed (all latency, idempotency, and PII benchmarks met).
   - `npm run test:e2e`: 19 files passed, 413 tests passed (Tiers 1–4 complete).

4. **Peer Milestone 2 Division of Labor:**
   - `explorer_m2_1`: Scope is `lib/engine/*` (`win-probability.ts`, `ev-engine.ts`, `decision-router.ts`).
   - `explorer_m2_2`: Scope is `lib/firewall/*` (`policy-firewall.ts`, `injection-defense.ts`).
   - `explorer_m2_3` (Current Agent): Scope is `lib/paypal/*` (`types.ts`, `simulator.ts`, `client.ts`, `index.ts`) and `app/api/*` (`webhooks/paypal`, `disputes/[id]/assess`, `mcp/tools`, `simulator/webhook`, `simulator/reset`).

---

## 2. Logic Chain

1. **Dual-Mode Contract & Offline Resilience (`BR-024`):**
   - Observations 1 and 2 establish that judges and test runners must run the system without any external network dependencies or required PayPal credentials.
   - Therefore, `lib/paypal/index.ts` must implement `getPayPalMode()` to inspect `process.env.PAYPAL_MODE` and the presence of non-mock credentials (`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`).
   - If missing or set to `sandbox_simulated`, the client factory returns `MockPayPalSimulator` (`lib/paypal/simulator.ts`), which queries local SQLite tables (`orders`, `disputes`, `evidence_items`) and falls back to `GOLDEN_PERSONAS` without throwing errors.
   - If valid credentials exist and `PAYPAL_MODE=sandbox_live`, it returns `LivePayPalClient` (`lib/paypal/client.ts`), which performs OAuth 2.0 client credentials authentication against `https://api-m.sandbox.paypal.com`.

2. **Webhook Ingestion, Idempotency & Decision Routing (`BR-011`):**
   - Observation 2 confirms `webhook_events.webhook_id` has a unique index (`idx_webhooks_webhook_id`).
   - Observation 3 confirms `tests/nfr/idempotency.test.ts` expects duplicate webhooks to return HTTP 200 with `{ status: "DUPLICATE_IGNORED" }`.
   - Therefore, `app/api/webhooks/paypal/route.ts` must first check for existing `webhook_id`. If found, it immediately responds with `DUPLICATE_IGNORED`.
   - For new webhooks, it executes an atomic transaction (`runTransaction`) inserting the dispute, gathering evidence, scoring Win Probability ($W$) and EV, evaluating the Step 18 Decision Table (R1..R8), updating dispute track/status, and logging to `audit_logs` in a single transactional write.

3. **MCP Tool Dispatcher & Policy Firewall Interception (`BR-004`, `BR-006`):**
   - Observations 1 and 4 confirm the buyer negotiation chat requires MCP tools (`make-offer`, `provide-evidence`, `accept-claim`).
   - `app/api/mcp/tools/route.ts` implements both `GET` (declaring tool schemas for LLM agent reflection) and `POST` (executing tool invocations).
   - In `make-offer`, the endpoint intercepts proposed refund amounts using `PolicyFirewall.validateSettlementOffer`. If `offer_amount_cents > MaxAllowedCents` ($40\%$ cap), it clamps or rejects the offer, increments `guardrail_triggered_count`, and writes `guardrail_status = 'BLOCKED'` to `audit_logs`.

4. **Judge Demo Bar Synthetic Triggers & Fast Reset:**
   - Observations 2 and 3 show that `runGoldenSeeder()` in `scripts/seed.ts` resets SQLite in $< 500\text{ms}$.
   - `app/api/simulator/reset/route.ts` imports and invokes `runGoldenSeeder()`, restoring pristine baseline KPIs.
   - `app/api/simulator/webhook/route.ts` generates synthetic `CUSTOMER.DISPUTE.CREATED` webhooks for `DSP-GOLD-001` through `DSP-GOLD-005`, allowing judges to observe automated routing in real time.

---

## 3. Caveats

1. **Dependency on Peer Modules:**
   - `app/api/webhooks/paypal/route.ts` and `app/api/disputes/[id]/assess/route.ts` import `calculateWinProbability`, `calculateExpectedEV`, and `routeDecisionTable` from `lib/engine/*`.
   - `app/api/mcp/tools/route.ts` imports `PolicyFirewall` from `lib/firewall/*`.
   - The implementation worker must ensure `lib/engine/*` and `lib/firewall/*` (from `explorer_m2_1` and `explorer_m2_2`) are in place or provide graceful type-safe fallback stubs during initial compilation.
2. **Next.js 15 Async Route Params:**
   - In `app/api/disputes/[id]/assess/route.ts`, route params must be awaited (`const { id } = await params;`). Failing to await will cause Next.js 15 runtime errors.
3. **No Network Access in CI/Offline Testing:**
   - When running Vitest test suites, `PAYPAL_MODE` must remain `sandbox_simulated` (the default) so no external HTTP requests are attempted.

---

## 4. Conclusion

The technical design for Milestone 2 Dual-Mode PayPal Sandbox & API Route Handlers is complete, verified against existing SQLite schema constraints, and fully specified in `plan.md`. The design comprises 9 core files:
1. `lib/paypal/types.ts`: TypeScript contracts for PayPal REST resources, actions, webhooks.
2. `lib/paypal/simulator.ts`: Deterministic SQLite-backed PayPal Disputes API mock.
3. `lib/paypal/client.ts`: Live PayPal Sandbox REST client with OAuth2 token caching.
4. `lib/paypal/index.ts`: Dual-mode factory router with UI status badge helper.
5. `app/api/webhooks/paypal/route.ts`: Webhook ingestion, signature check, deduplication (`BR-011`), auto-assessment, and Decision Router execution.
6. `app/api/disputes/[id]/assess/route.ts`: On-demand AI assessment & EV calculation route.
7. `app/api/mcp/tools/route.ts`: MCP tool dispatcher (`make-offer`, `provide-evidence`, `accept-claim`) guarded by `PolicyFirewall`.
8. `app/api/simulator/webhook/route.ts`: Demo bar synthetic webhook generator for Golden Personas.
9. `app/api/simulator/reset/route.ts`: 1-click Golden Dataset reset endpoint.

---

## 5. Verification Method

Once implemented by the worker, independently verify Milestone 2 using:

1. **Pre-Code Quality Gates:**
   ```powershell
   npm run test:dq
   npm run test:rules
   npm run test:nfr
   ```
   *Expected:* All 3 gates pass 100%.

2. **E2E Feature Coverage:**
   ```powershell
   npm run test:e2e
   ```
   *Expected:* All 19 test files and 413 tests pass.

3. **Next.js Build & Route Type Check:**
   ```powershell
   npm run build
   ```
   *Expected:* Clean compilation without any bundler or TypeScript type errors.

4. **Interactive Endpoint Spot-Checks:**
   - Test DB Reset:
     ```powershell
     Invoke-RestMethod -Method POST -Uri "http://localhost:3000/api/simulator/reset"
     ```
     *Expected:* HTTP 200 with `{ success: true, dispute_count: 50 }`.
   - Test MCP Tool Schemas:
     ```powershell
     Invoke-RestMethod -Method GET -Uri "http://localhost:3000/api/mcp/tools"
     ```
     *Expected:* JSON containing `make-offer`, `provide-evidence`, `accept-claim` schemas.
