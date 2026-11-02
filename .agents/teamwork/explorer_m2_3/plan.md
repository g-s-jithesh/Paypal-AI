# Milestone 2 Technical Implementation Plan: Dual-Mode PayPal Sandbox & API Route Handlers

**Author:** `explorer_m2_3` (teamwork_explorer)  
**Scope:** `lib/paypal/*`, `app/api/webhooks/*`, `app/api/disputes/*`, `app/api/mcp/*`, `app/api/simulator/*`  
**Lifecycle Stage:** DDDL Phase 7 (Core Decision Engine & Integrations)  
**Authoritative References:** `PROJECT.md`, `chargeback_shield_prd.md`, `dddl_execution_plan.md`, `SPEC-SURVEY-002`

---

## 1. Executive Architecture Overview

Milestone 2 establishes the core integration and API layer of **ChargebackShield**, linking the Next.js App Router to local SQLite data and external/simulated PayPal APIs:

```
                                  +---------------------------------------+
                                  | Inbound HTTP Requests / Webhooks / UI |
                                  +-------------------+-------------------+
                                                      |
                   +----------------------------------+----------------------------------+
                   |                                  |                                  |
                   v                                  v                                  v
     +---------------------------+      +---------------------------+      +---------------------------+
     | /api/webhooks/paypal      |      | /api/mcp/tools            |      | /api/simulator/reset      |
     | - Signature Verification  |      | - GET: Tool Schemas       |      | - 1-Click Golden DB Reset |
     | - Deduplication (BR-011)  |      | - POST: Tool Dispatch     |      | /api/simulator/webhook    |
     | - Step 18 Decision Router |      | - Policy Firewall Guard   |      | - Synthetic Persona Hooks |
     | - SQLite Atomic Pipeline  |      |   (BR-004 Cap, BR-006)    |      | /api/disputes/[id]/assess |
     +-------------+-------------+      +-------------+-------------+      +---------------------------+
                   |                                  |
                   +------------------+---------------+
                                      |
                                      v
                        +---------------------------+
                        | lib/paypal/index.ts       |
                        | Dual-Mode Client Factory  |
                        +-------------+-------------+
                                      |
                     +----------------+----------------+
                     | Checks process.env.PAYPAL_MODE  |
                     | & Credentials Presence (BR-024) |
                     +----------------+----------------+
                                      |
                 +--------------------+--------------------+
                 |                                         |
                 v                                         v
   +---------------------------+             +---------------------------+
   | Mode A: Local Simulator   |             | Mode B: Live Sandbox REST |
   | lib/paypal/simulator.ts   |             | lib/paypal/client.ts      |
   | - 100% Offline Resilience |             | - OAuth2 Client Creds     |
   | - Local SQLite Integration|             | - Live Sandbox Disputes   |
   | - Golden Personas Pre-seed|             | - Webhook Signature Verify|
   +---------------------------+             +---------------------------+
```

---

## 2. Component Specifications

### 2.1 Type Contracts: `lib/paypal/types.ts`
Defines standard interfaces matching the PayPal Disputes API v1 and Orders v2 REST specifications:

```typescript
export interface PayPalDisputeAmount {
  currency_code: string;
  value: string; // e.g. "145.00"
}

export interface PayPalDisputedTransaction {
  seller_transaction_id: string;
  buyer_transaction_id?: string;
  gross_amount: PayPalDisputeAmount;
  buyer?: {
    name?: string;
    email?: string;
  };
}

export interface PayPalDisputeResource {
  dispute_id: string;
  create_time: string;
  update_time: string;
  dispute_amount: PayPalDisputeAmount;
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' | 'SIGNIFICANTLY_NOT_AS_DESCRIBED' | 'UNAUTHORISED' | 'CANCELLED_RECURRING_BILLING' | 'OTHER';
  status: 'OPEN' | 'WAITING_FOR_SELLER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED' | 'OTHER';
  dispute_state?: 'REQUIRED_ACTION' | 'UNDER_REVIEW' | 'RESOLVED';
  dispute_life_cycle_stage?: 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';
  seller_response_due_date: string;
  disputed_transactions?: PayPalDisputedTransaction[];
  offer?: {
    offer_type: string;
    offer_amount: PayPalDisputeAmount;
    note?: string;
  };
  evidence?: Array<{
    evidence_type: string;
    notes?: string;
    date: string;
  }>;
}

export interface PayPalActionResponse {
  success: boolean;
  action: 'SUBMIT_EVIDENCE' | 'MAKE_OFFER' | 'ACCEPT_CLAIM' | 'SEND_MESSAGE';
  dispute_id: string;
  paypal_reference_id: string;
  status: string;
  timestamp: string;
  offer_amount?: PayPalDisputeAmount;
  error?: string;
}

export interface EvidenceSubmissionPayload {
  evidence_type: 'PROOF_OF_DELIVERY' | 'PROOF_OF_SERVICE' | 'CUSTOMER_COMMUNICATION' | 'REFUND_POLICY' | 'ITEM_DESCRIPTION';
  notes?: string;
  evidence_info?: {
    tracking_info?: Array<{
      carrier_name: string;
      tracking_number: string;
    }>;
  };
  tracking_number?: string;
  carrier?: string;
}

export interface SettlementOfferPayload {
  offer_type?: 'REFUND' | 'REPLACEMENT';
  offer_amount?: PayPalDisputeAmount;
  amount_cents?: number;
  note?: string;
}

export interface PayPalDisputeClient {
  getDispute(disputeId: string): Promise<PayPalDisputeResource>;
  provideEvidence(disputeId: string, evidence: EvidenceSubmissionPayload): Promise<PayPalActionResponse>;
  makeOffer(disputeId: string, offer: SettlementOfferPayload): Promise<PayPalActionResponse>;
  acceptClaim(disputeId: string, reason?: string): Promise<PayPalActionResponse>;
  sendMessage?(disputeId: string, message: string): Promise<PayPalActionResponse>;
  getOrder?(orderId: string): Promise<any>;
  verifyWebhookSignature?(headers: Headers | Record<string, string>, body: any): Promise<boolean>;
}
```

---

### 2.2 Local PayPal Sandbox Simulator: `lib/paypal/simulator.ts`

- **Purpose:** Provide a 100% offline, deterministic, zero-network mock of the PayPal Disputes & Orders APIs.
- **SQLite Integration:**
  - Queries local `chargeback_shield.db` using `getDb()`.
  - Maps records between internal schema (`ENT-02`, `ENT-03`, `ENT-04`, `ENT-07`) and PayPal REST responses.
- **Methods:**
  1. `getDispute(disputeId: string)`:
     - Looks up by `disputes.paypal_dispute_id = ? OR disputes.id = ?`.
     - Joins `orders` to retrieve order and buyer metadata.
     - Fetches existing `evidence_items` and latest `settlement_offers`.
     - Returns populated `PayPalDisputeResource`.
     - If not in DB, checks static `GOLDEN_PERSONAS` fallback (`PP-D-GOLD-001` .. `PP-D-GOLD-005`).
     - Throws `Error('PayPal Dispute ${disputeId} not found in simulator')` if unknown.
  2. `provideEvidence(disputeId: string, evidence: EvidenceSubmissionPayload)`:
     - Validates existence of dispute.
     - Generates reference ID: `PP-EV-${Date.now()}`.
     - Stores in local map or updates DB if requested.
     - Returns `{ success: true, action: 'SUBMIT_EVIDENCE', dispute_id: disputeId, paypal_reference_id, status: 'EVIDENCE_SUBMITTED', timestamp }`.
  3. `makeOffer(disputeId: string, offer: SettlementOfferPayload)`:
     - Validates existence of dispute.
     - Normalizes dollar string vs integer cents (`value: (amount_cents / 100).toFixed(2)`).
     - Generates reference ID: `PP-OFF-${Date.now()}`.
     - Returns `{ success: true, action: 'MAKE_OFFER', dispute_id: disputeId, paypal_reference_id, offer_amount: { currency_code: 'USD', value }, status: 'OFFER_PROPOSED', timestamp }`.
  4. `acceptClaim(disputeId: string, reason?: string)`:
     - Validates existence of dispute.
     - Generates reference ID: `PP-ACC-${Date.now()}`.
     - Returns `{ success: true, action: 'ACCEPT_CLAIM', dispute_id: disputeId, paypal_reference_id, status: 'CLAIM_ACCEPTED', timestamp }`.
  5. `getOrder(orderId: string)`:
     - Looks up `orders` by `paypal_order_id = ? OR id = ?`.
     - Returns formatted PayPal Orders v2 resource (`id, status: 'COMPLETED', purchase_units: [...]`).

---

### 2.3 Live PayPal REST Client: `lib/paypal/client.ts`

- **Purpose:** Full production integration with `https://api-m.sandbox.paypal.com` (or live).
- **OAuth 2.0 Client Credentials Grant:**
  - Token caching in memory: `cachedToken = { token, expiresAt }`.
  - When `Date.now() >= expiresAt - 60000`, executes `POST /v1/oauth2/token` with HTTP Basic Authorization header (`Buffer.from(clientId + ':' + clientSecret).toString('base64')`) and body `grant_type=client_credentials`.
- **Endpoints Implemented:**
  - `GET /v1/customer/disputes/{dispute_id}`
  - `POST /v1/customer/disputes/{dispute_id}/provide-evidence`
  - `POST /v1/customer/disputes/{dispute_id}/make-offer`
  - `POST /v1/customer/disputes/{dispute_id}/accept-claim`
  - `POST /v1/notifications/verify-webhook-signature`
- **Error Handling & Resilience:**
  - 401 Unauthorized: Clears cached token and retries request once.
  - 429 Too Many Requests: Extracts `Retry-After` header or throws typed `PayPalRateLimitError`.
  - 404 Not Found: Throws typed `PayPalNotFoundError`.
  - Timeout: Configured with 10-second `AbortSignal`.

---

### 2.4 Dual-Mode Router & Factory: `lib/paypal/index.ts`

- **Purpose:** Seamless toggle between Simulator and Live Sandbox satisfying **`BR-024`** (zero-error fallback).
- **Mode Detection Logic:**
  ```typescript
  export function getPayPalMode(): 'sandbox_simulated' | 'sandbox_live' {
    const mode = (process.env.PAYPAL_MODE || '').toLowerCase();
    const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
    const secret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();

    const isLiveFlag = mode === 'sandbox_live' || mode === 'sandbox' || mode === 'live';
    const hasCreds = Boolean(clientId && secret && !clientId.startsWith('mock_') && !clientId.startsWith('sb-client-mock'));

    return isLiveFlag && hasCreds ? 'sandbox_live' : 'sandbox_simulated';
  }
  ```
- **Factory:**
  ```typescript
  let simulatorInstance: MockPayPalSimulator | null = null;
  let liveClientInstance: LivePayPalClient | null = null;

  export function getPayPalClient(): PayPalDisputeClient {
    if (getPayPalMode() === 'sandbox_live') {
      if (!liveClientInstance) liveClientInstance = new LivePayPalClient();
      return liveClientInstance;
    }
    if (!simulatorInstance) simulatorInstance = new MockPayPalSimulator();
    return simulatorInstance;
  }
  ```
- **UI Status Badge Contract:**
  ```typescript
  export function getPayPalBadgeInfo() {
    const isLive = getPayPalMode() === 'sandbox_live';
    return {
      mode: isLive ? 'sandbox_live' : 'sandbox_simulated',
      label: isLive ? '🔷 PayPal: Live Sandbox [Connected]' : '🟢 PayPal: Local Simulator [Deterministic]',
      color: isLive ? 'blue' : 'emerald',
      isLive
    };
  }
  ```

---

### 2.5 Ingestion & Autopilot Route: `app/api/webhooks/paypal/route.ts`

- **Purpose:** Ingests PayPal webhooks, enforces deduplication (`BR-011`), validates signatures, automatically enriches data, scores Win Probability & EV, executes Step 18 Decision Table, and records immutable audit logs.
- **Pipeline Stages:**
  1. **Header Extraction:** `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url`, `paypal-auth-algo`.
  2. **Signature Validation:**
     - Live Mode: calls `client.verifyWebhookSignature(...)`. Quarantines on mismatch.
     - Simulated Mode: validates header presence and structure.
  3. **Idempotency Gate (`BR-011` / `NFR-003`):**
     ```sql
     SELECT id FROM webhook_events WHERE webhook_id = ?
     ```
     If found, immediately returns HTTP 200 with `{ status: 'DUPLICATE_IGNORED', webhook_id }`.
  4. **Atomic Transaction (`runTransaction`):**
     - Inserts initial `webhook_events` record with `processing_status = 'PENDING'`.
     - Processes `CUSTOMER.DISPUTE.CREATED`:
       - Extracts PayPal dispute ID, order ID, amount cents, reason code, and due date.
       - Validates `BR-001` (Dispute amount $\le$ Order amount) and `BR-002` (Due date in future).
       - Inserts into `disputes` (`status = 'EVIDENCE_GATHERING'`).
       - Assembles evidence items from `orders` tracking info and delivery signature.
       - Calculates Win Probability $W$ (`calculateWinProbability`).
       - Calculates $EV_{compete}$, $EV_{settle}$, $EV_{accept}$ (`calculateExpectedEV`).
       - Routes via Step 18 Decision Table (`routeDecisionTable` -> R1..R8).
       - Updates `disputes` to target `status` and `track` (`SUBMITTED`, `NEGOTIATING`, `SETTLED_VIA_REFUND`, `READY_FOR_REVIEW`).
       - If `AUTO_SUBMIT_EVIDENCE`: marks `submitted_at`, calls `client.provideEvidence(...)`.
       - If `OFFER_PARTIAL_REFUND`: creates `negotiation_sessions` record.
       - If `AUTO_ACCEPT_CLAIM`: marks `resolved_at`, calls `client.acceptClaim(...)`.
       - Inserts into `ai_assessments` (`ENT-05`).
       - Inserts into `audit_logs` (`ENT-09`) with `guardrail_status = 'PASSED'`.
       - Updates `webhook_events.processing_status = 'PROCESSED'`.
  5. **Response:** HTTP 200 with JSON `{ success: true, dispute_id, paypal_dispute_id, status, track, action, rule_id }`.

---

### 2.6 On-Demand Assessment Route: `app/api/disputes/[id]/assess/route.ts`

- **Purpose:** Re-evaluate AI Win Probability and Expected Value for any existing dispute on demand.
- **Next.js 15 Async Route Params:**
  ```typescript
  export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
  ) {
    const { id } = await params;
    // ...
  }
  ```
- **Execution:**
  1. Resolves dispute from DB by `id` or `paypal_dispute_id`.
  2. Loads order, policy rules, and gathered evidence items.
  3. Executes Win Probability and EV engines.
  4. Determines Step 18 recommended action.
  5. Inserts new entry in `ai_assessments` (`ENT-05`).
  6. Inserts audit log entry.
  7. Returns assessment metrics: `{ success: true, dispute_id, win_probability, ev_compete_cents, ev_settle_cents, recommended_action, rule_id, assessment_id }`.

---

### 2.7 MCP Tool Dispatcher: `app/api/mcp/tools/route.ts`

- **Purpose:** Implements Model Context Protocol (MCP) tool exposure and execution guarded by the code-level `PolicyFirewall`.
- **Methods:**
  - `GET`: Returns JSON tool declarations for MCP clients:
    - `make-offer`: Parameters `dispute_id`, `offer_amount_cents`, `rationale`.
    - `provide-evidence`: Parameters `dispute_id`, `evidence_type`, `evidence_summary`, `tracking_number`, `carrier`.
    - `accept-claim`: Parameters `dispute_id`, `reason`.
  - `POST`: Executes tool with input parameters:
    1. For `make-offer`:
       - Invokes `PolicyFirewall.validateSettlementOffer(dispute_id, offer_amount_cents)`.
       - If `offer_amount_cents > maxAllowedCents`:
         - Clamps offer to `maxAllowedCents`.
         - Increments `guardrail_triggered_count` in `negotiation_sessions`.
         - Inserts audit log with `guardrail_status = 'BLOCKED'`, `action = 'FIREWALL_INTERCEPT'`.
         - Returns `{ success: false, error: 'EXCEEDS_POLICY_CAP', allowed: false, clamped: true, original_cents, final_cents: maxAllowedCents }`.
       - If `dispute_amount_cents > 25000` (`BR-006` High-Value Gate):
         - Blocks autonomous offer, routes dispute to `READY_FOR_REVIEW`.
         - Returns `{ success: false, error: 'HIGH_VALUE_GATE_TRIGGERED', status: 'READY_FOR_REVIEW' }`.
       - If approved:
         - Inserts into `settlement_offers` (`ENT-07`).
         - Calls `paypalClient.makeOffer(...)`.
         - Inserts audit log with `guardrail_status = 'PASSED'`.
         - Returns `{ success: true, tool: 'make-offer', offer_id, final_amount_cents, paypal_reference_id }`.
    2. For `provide-evidence`:
       - Validates evidence against DB records (`BR-008` Zero-Hallucination rule).
       - Calls `paypalClient.provideEvidence(...)`.
       - Updates dispute `status = 'SUBMITTED'`.
       - Returns `{ success: true, tool: 'provide-evidence', paypal_reference_id }`.
    3. For `accept-claim`:
       - Calls `paypalClient.acceptClaim(...)`.
       - Updates dispute `status = 'SETTLED_VIA_REFUND'`.
       - Returns `{ success: true, tool: 'accept-claim', paypal_reference_id }`.

---

### 2.8 Demo Bar Webhook Simulator: `app/api/simulator/webhook/route.ts`

- **Purpose:** Generates synthetic PayPal `CUSTOMER.DISPUTE.CREATED` webhooks for the 5 Golden Personas (`DSP-GOLD-001` through `DSP-GOLD-005`) for 1-click judge evaluation.
- **Request Body:** `{ persona: 'DSP-GOLD-001' | ... }`
- **Execution:**
  1. Retrieves metadata from `GOLDEN_PERSONAS`.
  2. Generates unique transmission ID: `PAYPAL-SIM-TX-${persona}-${Date.now()}`.
  3. Formats canonical PayPal Dispute Created webhook JSON.
  4. Dispatches internally to the webhook ingestion engine.
  5. Returns `{ success: true, transmission_id, persona, webhook_payload, result }`.

---

### 2.9 1-Click Golden DB Reset: `app/api/simulator/reset/route.ts`

- **Purpose:** Restores pristine 50-record Golden Dataset in $< 500\text{ms}$ (`US-006` / `Step 45`).
- **Method:** `POST`
- **Execution:**
  1. Calls `runGoldenSeeder()` from `scripts/seed.ts`.
  2. Runs within an atomic SQLite transaction:
     - Wipes all mutable tables in FK-safe order.
     - Temporarily handles audit log trigger.
     - Re-seeds all 50 disputes, orders, evidence items, and baseline policy rules.
  3. Verifies KPI reconciliation.
  4. Returns `{ success: true, message: 'Database successfully reset to Golden Dataset state', dispute_count: 50, duration_ms, timestamp }`.

---

## 3. Step-by-Step Implementation Sequence

```
Step 1: lib/paypal/types.ts
        └── Create PayPal Dispute & Orders REST v1/v2 interfaces, payloads, action responses.

Step 2: lib/paypal/simulator.ts
        └── Implement MockPayPalSimulator querying better-sqlite3 with Golden Personas fallback.

Step 3: lib/paypal/client.ts
        └── Implement LivePayPalClient with OAuth2 Client Credentials grant, token caching, fetch.

Step 4: lib/paypal/index.ts
        └── Implement getPayPalMode(), getPayPalClient(), getPayPalBadgeInfo() factory router.

Step 5: app/api/webhooks/paypal/route.ts
        └── Implement ingestion, signature check, BR-011 deduplication, EV scoring, Decision Router.

Step 6: app/api/disputes/[id]/assess/route.ts
        └── Implement on-demand AI assessment route handler with Next.js 15 async params.

Step 7: app/api/mcp/tools/route.ts
        └── Implement MCP tool dispatcher (GET schema + POST dispatch guarded by PolicyFirewall).

Step 8: app/api/simulator/webhook/route.ts
        └── Implement synthetic webhook trigger for Golden Personas.

Step 9: app/api/simulator/reset/route.ts
        └── Implement 1-click deterministic seeder reset endpoint.

Step 10: Verification
        └── Run Vitest test suites (test:dq, test:rules, test:nfr, test:e2e) + Next.js build verification.
```

---

## 4. Verification & Validation Plan

| Test Command | What It Validates | Target Result |
| :--- | :--- | :--- |
| `npm run test:dq` | Data quality & constraints across all 10 entities | 100% DQ Score |
| `npm run test:rules` | BR-001 to BR-025, Step 18 Decision Table, and State Machine | 100% Pass |
| `npm run test:nfr` | Webhook idempotency (BR-011), latency (< 250ms), PII masking | 100% Pass |
| `npm run test:e2e` | Tier 1-4 E2E test suites (all 413 tests) | 100% Pass |
| `npm run build` | Next.js 15 App Router production compile & type check | Clean Exit Code 0 |
| `curl -X POST /api/simulator/reset` | 1-click DB reset endpoint | Restores 50 records in < 500ms |
| `curl -X POST /api/webhooks/paypal` | Inbound webhook deduplication & routing | Returns 200 OK, routes correctly |
