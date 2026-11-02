# Project: ChargebackShield (AI Dispute & Refund Resolution Autopilot)

## Architecture
ChargebackShield is built on a unified, high-performance fullstack architecture following the Talencia Global Data-Driven Development Lifecycle (DDDL v1.0).

- **Framework**: Next.js 15 (App Router) + TypeScript + React 19 Server Components (RSC)
- **Database**: SQLite via `better-sqlite3` (`chargeback_shield.db`), strictly implementing all 10 core entities (`ENT-01` to `ENT-10`) with `PRAGMA foreign_keys = ON;`, strict `CHECK` constraints, integer monetary amounts (`amount_cents`), and composite performance indexes.
- **Pre-Code Quality Gates**: Vitest test runner executing:
  - `npm run test:dq`: 100% Data Quality score across all 10 core tables.
  - `npm run test:rules`: 100% business rule verification (`BR-001` through `BR-025`) and state transition validations.
  - `npm run test:nfr`: Query latency (< 50ms), concurrent webhook burst idempotency, and PII redaction.
- **Seeding & Golden Dataset**: Deterministic seeder (`scripts/seed.ts`, `npm run db:seed`) creating 50 Golden Dataset disputes (`DSP-GOLD-001` through `DSP-GOLD-005`) with deterministic metrics.
- **Core Decision Engine**:
  - AI Win Probability ($W$) weighting heuristic and Expected Value ($EV$) engine (`BR-007`).
  - Step 18 Decision Table router (`BR-016`) executing actions: `AUTO_SUBMIT_EVIDENCE`, `OFFER_PARTIAL_REFUND`, `AUTO_ACCEPT_CLAIM`, and `ESCALATE_TO_HUMAN`.
- **MCP Policy Firewall**: Deterministic code-level guardrail enforcing `BR-004` (refund offer $\le$ cap) and `BR-006` (human approval for disputes $> \$250$), neutralizing prompt injection attempts.
- **Dual-Mode PayPal Engine**:
  - Deterministic local PayPal Sandbox simulator for zero-dependency offline resilience.
  - Live PayPal Sandbox REST API client dynamically activated via `.env.local` credentials.
- **Frontend & Views**:
  - C-Suite Executive BI Command Center (`/`): KPI-001 through KPI-006 with 100% live SQL reconciliation, plus "What-If" Policy Threshold Simulator.
  - Analyst Dispute Autopilot Workbench (`/disputes`): SLA countdown badges, evidence package builder with SHA-256 zero-hallucination verification (`BR-008`).
  - Buyer Negotiation Chat Portal (`/negotiate/[id]`): Live negotiation with `make-offer` tool and visual firewall interception indicator.
  - Interactive Judge Demo Bar: Persistent 1-click controls for webhook simulation, prompt injection tests, MCP audit inspector, and Golden DB reset.

---

## Feature Inventory
Every feature identified during Survey is catalogued below with its assigned milestone.

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | SQLite DDL Schema (`ENT-01`–`ENT-10`) | Full schema with FKs, check constraints, composite indexes, integer cents | M1 | PRD §6.1, Plan Step 06 |
| 2 | Data Dictionary v2 | Markdown documentation of all 10 entities, types, constraints, PII tags | M1 | Plan Step 09 |
| 3 | Deterministic Golden Dataset Seeder | Seeder populating 50 disputes with DSP-GOLD-001..005 personas (`db:seed`) | M1 | PRD §11, Plan Step 24 |
| 4 | Scale Seeder | Volumetric seeder supporting scale testing (`db:seed:scale`) | M1 | Plan Step 25 |
| 5 | Pre-Code Data Quality Gate (`test:dq`) | Automated test suite validating 100% DQ, completeness, zero orphans | M1 | Plan Step 26, Playbook G4 |
| 6 | Pre-Code Business Rules Gate (`test:rules`) | Automated test suite validating BR-001..025 and state transitions | M1 | Plan Step 27, Playbook G4 |
| 7 | Pre-Code NFR Gate (`test:nfr`) | Automated test suite validating latency, idempotency, PII masking | M1 | Plan Step 28, Playbook G4 |
| 8 | AI Win Probability Engine | Feature-weighted win probability scoring model (0.00 to 1.00) | M2 | PRD §6.4, Plan Step 18 |
| 9 | Expected Value (EV) Engine | Mathematical EV formulas ($EV_{Compete}$, $EV_{Settle}$, $EV_{Accept}$) | M2 | PRD §6.3, BR-007 |
| 10 | Step 18 Decision Table Router | Deterministic 8-rule routing matrix for disputes | M2 | PRD §6.4, BR-016 |
| 11 | MCP Policy Firewall | Code-level refund cap enforcement (BR-004) and high-value gate (BR-006) | M2 | PRD §6.3, Plan Step 39 |
| 12 | 3-Layer Prompt Injection Defense | Sanitizer, system prompt boundary, and deterministic tool validator | M2 | Survey 2, PRD §8 |
| 13 | Local PayPal Sandbox Simulator | Deterministic local mock of PayPal Disputes & Orders REST endpoints | M2 | PRD §6.5, Plan Step 22 |
| 14 | Live PayPal REST Integration | Dynamic toggle to live PayPal Sandbox via `.env.local` credentials | M2 | PRD §6.5, Plan Step 23 |
| 15 | C-Suite BI Executive Dashboard | Executive dashboard displaying KPI-001 through KPI-006 | M3 | PRD §7, Plan Step 29 |
| 16 | 100% Live SQL KPI Reconciliation | Zero-drift SQL queries reconciling C-Suite KPIs against DB tables | M3 | PRD §7, Plan Step 30 |
| 17 | "What-If" Policy Threshold Simulator | Dynamic simulator sliders with historical replay over Golden Dataset | M3 | PRD §6.2, Plan Step 34 |
| 18 | Interactive Judge Demo Bar | Persistent bar for 1-click webhooks, injection tests, DB reset | M3 | PRD §6.2, Plan Step 45 |
| 19 | Dispute Autopilot Workbench Queue | Analyst workbench with queue filtering and SLA countdown badges | M4 | PRD §6.2, Plan Step 33 |
| 20 | Multi-Source Evidence Auto-Assembler | Ingestion of carrier tracking, customer logs, order metadata | M4 | PRD §6.2, Plan Step 16 |
| 21 | SHA-256 Zero-Hallucination Verifier | AST/Regex verification of evidence facts against DB records (BR-008) | M4 | PRD §6.3, BR-008 |
| 22 | High-Value Dispute Human Approval Gate | 1-click analyst approval workflow for disputes $> \$250$ (BR-006) | M4 | PRD §6.3, BR-006 |
| 23 | Autonomous Buyer Negotiation Chat | Real-time chat portal with `make-offer` tool for settlement negotiation | M4 | PRD §6.2, Plan Step 32 |
| 24 | Visual Firewall Interception Indicator | Immediate UI alert when prompt injection attempts are blocked | M4 | PRD §8, Issue #3 |
| 25 | Security & Functional Test Suites | Tests for TC-FUNC-001..015 and TC-SEC-001 (prompt injection attacks) | M4 | Plan Step 36, 41 |
| 26 | Tier 1 E2E Feature Coverage Tests | $\ge 5$ tests per feature covering all happy-path flows | E2E | Dual Track Specs |
| 27 | Tier 2 E2E Boundary & Corner Tests | $\ge 5$ tests per feature covering edge cases and limits | E2E | Dual Track Specs |
| 28 | Tier 3 E2E Cross-Feature Combinations | Pairwise interaction tests across modules and state changes | E2E | Dual Track Specs |
| 29 | Tier 4 E2E Real-World Application Workloads | End-to-end user journeys (UAT-001 through UAT-006) | E2E | Dual Track Specs |
| 30 | Tier 5 Adversarial Coverage Hardening | White-box stress tests, fault injection, edge condition attacks | M5 | Dual Track Specs |
| 31 | Dockerfile & render.yaml Packaging | Multi-stage Docker container and Render configuration for 1-click deploy | M5 | Survey 3, Req R6 |
| 32 | Comprehensive README & Video Script | Full setup guide, DDDL compliance report, 3-min video demo walkthrough | M5 | Req R6, Issue #2 |
| 33 | Git Branch Alignment & Origin Sync | Remote tracking branch alignment (`main`) and push to origin | M5 | Req R6, Issue #1 |
| 34 | Group Work Allocation Documentation | Formal mapping of @g-s-jithesh (40%), @abinaya-mani-11 (30%), @Mkkumar2006 (30%) | M5 | Req R6, Issues #1-#3 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Data Foundation & Pre-Code Quality Gates (DDDL 1–4) | Project skeleton, `db/schema.sql` (ENT-01..10), Data Dictionary v2, Golden Dataset Seeder (`npm run db:seed`), pre-code test suites (`npm run test:dq`, `npm run test:rules`, `npm run test:nfr`) passing 100% | None | DONE |
| M2 | Core Engines: EV Router, MCP Firewall & Dual-Mode Sandbox (DDDL 7) | AI EV calculation engine, Step 18 Decision Table router, MCP Policy Firewall with prompt injection defense, Local PayPal Sandbox Simulator + Live REST API toggle | M1 | IN_PROGRESS |
| M3 | C-Suite Executive BI Command Center & "What-If" Simulator (DDDL 5 & 8) | C-Suite analytics dashboard (KPI-001..006 100% SQL reconciliation), "What-If" ROI policy simulator, Interactive Judge Demo Bar | M1, M2 | PLANNED |
| M4 | Dispute Autopilot Workbench, Evidence Verifier & Buyer Portal (DDDL 6 & 8) | Analyst workbench queue with SLA badges, evidence auto-assembler with SHA-256 verifier (BR-008), high-value approval gate, buyer chat portal with firewall feedback | M1, M2 | PLANNED |
| M5 | Final Acceptance, 100% E2E Pass, Adversarial Hardening & Release Package | Pass 100% E2E test suite (Tiers 1-4), Tier 5 adversarial hardening, clean build (`npm run build`), Dockerfile/render.yaml verification, README & work allocation docs, Git sync | M1, M2, M3, M4, E2E | PLANNED |
| E2E | E2E Testing Track (Requirement-Driven, Opaque-Box) | Design E2E test infrastructure, runner, and test suites for Tiers 1–4 across all 34 features; publish `TEST_READY.md` | M1 | IN_PROGRESS |

---

## Interface Contracts

### 1. Database Layer (`lib/db.ts`) $\leftrightarrow$ Application Consumers
- **Database Connection**: Export singleton `getDb(): Database` using `better-sqlite3`.
- **Foreign Keys**: `PRAGMA foreign_keys = ON;` enabled on every connection.
- **Monetary Unit**: All currency fields are strictly integers in USD cents (`amount_cents`).
- **Audit Logging**: Every state change or decision execution writes to `audit_logs` (`ENT-09`).

### 2. Dual-Mode PayPal Engine (`lib/paypal/`) $\leftrightarrow$ Core Routers
- **Interface**:
  - `fetchDispute(disputeId: string): Promise<PayPalDispute>`
  - `submitEvidence(disputeId: string, evidence: EvidencePackage): Promise<PayPalSubmissionResult>`
  - `makeOffer(disputeId: string, offer: SettlementOffer): Promise<PayPalOfferResult>`
  - `acceptClaim(disputeId: string): Promise<PayPalAcceptResult>`
- **Mode Toggle**: Controlled by `PAYPAL_MODE` environment variable (`sandbox_simulated` vs `sandbox_live`).
- **Fallback**: If `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` are missing, automatically falls back to `sandbox_simulated` with deterministic responses.

### 3. MCP Policy Firewall (`lib/firewall/`) $\leftrightarrow$ Buyer Negotiation & Tools
- **Function**: `validateSettlementOffer(merchantId: string, disputeId: string, offeredCents: number): ValidationResult`
- **Enforcement**:
  - `BR-004`: `offeredCents <= dispute_amount_cents * max_refund_offer_pct / 100`.
  - Rejection: Returns `{ allowed: false, reason: 'EXCEEDS_POLICY_CAP' }`. Cannot be bypassed by prompt manipulation.

### 4. AI Assessment & Decision Engine (`lib/engine/`) $\leftrightarrow$ Dispute Ingestion
- **Function**: `assessDispute(dispute: Dispute, order: Order, evidence: EvidenceItem[]): AssessmentResult`
- **Output**:
  - `win_probability`: number (0.00 to 1.00)
  - `expected_value_cents`: integer
  - `recommended_action`: `'AUTO_SUBMIT_EVIDENCE' | 'OFFER_PARTIAL_REFUND' | 'AUTO_ACCEPT_CLAIM' | 'ESCALATE_TO_HUMAN'`
  - `decision_rule_id`: `'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8'`

### 5. Evidence Verifier (`lib/evidence/`) $\leftrightarrow$ PayPal Submission
- **Function**: `verifyEvidencePackage(packageData: EvidenceSubmission): VerificationReport`
- **Constraint (`BR-008`)**: All tracking numbers, carrier names, and delivery timestamps must exist in `orders` or `evidence_items` matching the order ID, verified via SHA-256 hash matching.

---

## Code Layout

```
paypalai/
├── db/
│   ├── schema.sql              # ENT-01 to ENT-10 SQLite DDL with constraints and indexes
│   └── index.ts                # Database connection helper and schema initialization
├── scripts/
│   ├── seed.ts                 # Deterministic Golden Dataset seeder (DSP-GOLD-001..005)
│   └── seed-scale.ts           # Volumetric seeder
├── lib/
│   ├── db.ts                   # better-sqlite3 database wrapper
│   ├── paypal/                 # Dual-Mode PayPal Sandbox (Local Simulator + Live REST)
│   ├── engine/                 # EV calculations, Win Probability, Step 18 Decision Table
│   ├── firewall/               # Deterministic MCP Policy Firewall (BR-004, BR-006)
│   ├── evidence/               # Multi-source evidence assembler & SHA-256 verifier (BR-008)
│   ├── kpi/                    # Live SQL query functions for KPI-001 to KPI-006
│   └── simulator/              # Historical replay and judge demo bar triggers
├── app/
│   ├── layout.tsx              # Root layout with persistent JudgeDemoBar
│   ├── page.tsx                # C-Suite Executive BI Dashboard & What-If Simulator
│   ├── disputes/
│   │   ├── page.tsx            # Dispute Autopilot Workbench Queue
│   │   └── [id]/page.tsx       # Dispute Detail & Evidence Package Builder
│   ├── negotiate/
│   │   └── [id]/page.tsx       # Autonomous Buyer Negotiation Chat Portal
│   └── api/
│       ├── webhooks/paypal/    # PayPal dispute webhook ingestion endpoint
│       ├── disputes/           # Dispute actions (assess, submit, offer)
│       ├── negotiate/          # Buyer chat & MCP tool execution
│       ├── kpis/               # C-Suite BI query endpoint
│       └── demo/               # Judge demo bar reset and simulation triggers
├── components/
│   ├── JudgeDemoBar.tsx        # Persistent 1-click Judge Demo Bar
│   ├── CSuiteDashboard.tsx     # KPI cards, Recharts visualizations, SQL reconciliation view
│   ├── WhatIfSimulator.tsx     # Policy threshold ROI simulator sliders
│   ├── DisputeWorkbench.tsx    # Queue, SLA countdowns, filters
│   ├── EvidenceBuilder.tsx     # Evidence review and SHA-256 validation status
│   └── BuyerChat.tsx           # Real-time chat with visual firewall intercept indicator
├── tests/
│   ├── dq/                     # npm run test:dq (Data quality, null checks, orphan checks)
│   ├── rules/                  # npm run test:rules (BR-001..025, state transitions)
│   ├── nfr/                    # npm run test:nfr (Latency, burst idempotency, PII masking)
│   ├── e2e/                    # E2E test suites (Tiers 1–4)
│   └── adversarial/            # Tier 5 Adversarial Coverage Hardening
├── DATA_DICTIONARY.md          # Comprehensive data dictionary v2
├── PROJECT.md                  # Project architecture and master index
├── Dockerfile                  # Production container packaging
├── render.yaml                 # 1-click cloud deployment config
└── README.md                   # Comprehensive hackathon submission documentation
```
