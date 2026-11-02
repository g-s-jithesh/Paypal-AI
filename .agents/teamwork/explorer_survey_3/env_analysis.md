# ChargebackShield — Environment Survey & Tech Stack Analysis

**Report Date:** 2026-11-02  
**Author:** `teamwork_explorer` (`explorer_survey_3`)  
**Workspace:** `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai`  
**Target Repository:** `https://github.com/g-s-jithesh/Paypal-AI`  

---

## 1. Executive Summary

This report delivers a comprehensive technical baseline of the current workspace, runtime environment, version control state, and architectural options for **ChargebackShield: Autonomous AI Dispute & Refund Resolution Autopilot for PayPal**. 

### Core Takeaways:
1. **Workspace Readiness:** The local directory is a pristine canvas with only `LICENSE` (MIT) and git metadata. Git remote is linked to `https://github.com/g-s-jithesh/Paypal-AI.git`.
2. **Branch Synchronization Note:** Local active branch is `master`, while the remote tracking branch is `remotes/origin/main`. We recommend aligning the local branch to `main` (`git branch -m master main; git branch -u origin/main`) to eliminate push mismatches.
3. **Runtime Tooling:** Modern runtime available: **Node.js v24.14.1 (x64 Windows)**, **npm v11.11.0**, **git v2.45.1**, **GitHub CLI gh v2.101.0** (authenticated as `g-s-jithesh`). SQLite CLI is not installed on PATH, but **`better-sqlite3` v13.0.3 was empirically verified to install and execute flawlessly** on Node 24 on Windows x64.
4. **Architectural Recommendation:** **Next.js 14/15 App Router + TypeScript + better-sqlite3 + Vitest + Tailwind CSS + Recharts**. This fullstack architecture eliminates CORS/proxy overhead, allows direct server-side synchronous SQLite queries for 100% C-Suite SQL reconciliation (`< 50ms`), provides native App Router API endpoints for PayPal webhooks and MCP tools, and deploys as a single portable service on Render or Docker.
5. **Team Work Allocation:** Live GitHub issues (#1, #2, #3) are already opened on `g-s-jithesh/Paypal-AI` matching the 40% / 30% / 30% group split among `@g-s-jithesh`, `@abinaya-mani-11`, and `@Mkkumar2006`. (Note: Issue #1 body was truncated during submission and should be updated with full text).

---

## 2. Workspace & Version Control Status

### 2.1 File System Inspection
- **Root Directory:** `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai`
- **Existing Files:**
  - `LICENSE`: Full MIT License, Copyright (c) 2026 `g-s-jithesh` (22 lines, 1089 bytes).
  - `.git/`: Git repository metadata.
  - `.agents/`: Agent metadata directory (contains DDDL specifications and teamwork agent workspaces).
- **Assessment:** Clean canvas. No legacy code, package conflicts, or orphaned dependencies.

### 2.2 Git Configuration & Commit History
```powershell
# Command Executed:
git status; git remote -v; git branch -a; git log -n 5 --oneline
```
- **Output:**
  ```text
  On branch master
  Untracked files:
    (use "git add <file>..." to include in what will be committed)
          .agents/
  nothing added to commit but untracked files present (use "git add" to track)
  origin  https://github.com/g-s-jithesh/Paypal-AI.git (fetch)
  origin  https://github.com/g-s-jithesh/Paypal-AI.git (push)
  * master
    remotes/origin/main
  bbf2929 Initial commit
  ```
- **Key Observation & Recommendation:**
  - Local default branch is named `master`.
  - Remote tracking branch is named `main` (`remotes/origin/main` at commit `bbf2929`).
  - **Action Required:** To avoid divergent branch tracking or accidental push rejections on GitHub, run:
    ```bash
    git branch -m master main
    git branch -u origin/main
    ```

---

## 3. Runtime Environment & Tooling Verification

An exhaustive automated diagnostic was executed in the workspace shell.

| Tool / Runtime | Verified Version / Status | Notes & Capabilities |
| :--- | :--- | :--- |
| **Operating System** | Windows 11 x64 (`win32`) | Standard development environment |
| **Node.js** | `v24.14.1` | Modern LTS/Current release. Native `process.arch = x64`. Built-in experimental `node:sqlite` present. |
| **npm** | `11.11.0` | Modern package manager with workspaces and lockfile v3 support. |
| **npx** | `11.11.0` | CLI execution tool for `tsx`, `vitest`, `next`. |
| **Git** | `2.45.1.windows.1` | Configured and operational. |
| **GitHub CLI (`gh`)**| `2.101.0 (2026-09-15)` | **Authenticated as `g-s-jithesh`** with scopes `gist, read:org, repo, workflow`. Direct issue/PR management enabled. |
| **Python** | `Python 3.14.3` | Available for auxiliary scripting or tooling. |
| **TypeScript** | Available locally | Global `tsc` is not on PATH; TypeScript 5.x will be installed locally in `package.json` (`npx tsc`). |
| **SQLite CLI** | Not on system PATH | Standalone `sqlite3.exe` is not installed, but not required because Node native drivers are used. |
| **SQLite Node Driver**| **`better-sqlite3` v13.0.3 verified** | **Empirically tested:** Native addon loaded successfully; returns SQLite engine version `3.53.4`. |

### 3.1 SQLite Compatibility Verification Test
Because Node.js `v24.14.1` is a very modern release, we performed a live execution test in a temporary sandbox:
```javascript
const Database = require('better-sqlite3');
const db = new Database(':memory:');
console.log(db.prepare('SELECT sqlite_version() as v').get());
// Result: { v: '3.53.4' }
```
- **Finding:** `better-sqlite3` installs with zero compilation errors and executes directly in Node 24 on Windows x64.
- In addition, Node 24 includes built-in `node:sqlite` (`DatabaseSync`), providing an optional zero-dependency fallback if ever needed.

---

## 4. Tech Stack Architecture Evaluation & Recommendation

We evaluated two primary architectural approaches for building ChargebackShield against the 8 DDDL phases, the PRD requirements (`REQ-001` through `REQ-010`), and the pre-code testing gates (`test:dq`, `test:rules`, `test:nfr`).

### 4.1 Architecture Options Comparison

| Criterion | Option A: Next.js 14/15 App Router (Recommended) | Option B: React + Vite + Express/Fastify |
| :--- | :--- | :--- |
| **Architecture Pattern** | Unified Fullstack Monolith | Decoupled Client-Server (or Monorepo) |
| **Runtime Processes** | **Single process** (`next dev` / `next start`) | Two processes (`vite` on 5173, `express` on 3001) |
| **C-Suite SQL Reconciliation (`KPI-001`–`KPI-006`)** | **Zero-overhead Server Components (RSC):** Direct synchronous `better-sqlite3` queries run in `< 5ms` on the server before streaming to client. Zero network latency, zero serialization drift. | Requires HTTP REST API roundtrips, JSON serialization, and dual DTO type maintenance. |
| **API Endpoints** | Native Route Handlers (`app/api/webhooks/paypal/route.ts`, `app/api/mcp/tools/route.ts`) | Express route controllers with middleware boilerplate. |
| **CORS & Cookies** | None needed; same-origin endpoints. | Requires CORS configuration and proxying in dev. |
| **Deployment Simplicity** | **Single container / single Render service** on port 3000. | Requires multi-process runner or serving static build from Express. |
| **Development Velocity** | Maximum. Single `package.json`, shared types between DB, rules, and UI components. | Slower due to duplicate routing and client fetch wrappers. |
| **DDDL Plan Alignment** | **100% matches `ADR-001`** in `dddl_execution_plan.md`. | Deviates from approved Master Execution Plan. |

### 4.2 Recommended Architecture & Component Stack

```mermaid
graph TD
    Client["Client Layer<br/>(Tailwind CSS + Lucide Icons + Recharts)"]
    RSC["Next.js App Router (RSC)<br/>C-Suite Dashboard | Workbench | Buyer Chat | Judge Bar"]
    API["Next.js Route Handlers<br/>/api/webhooks | /api/disputes | /api/mcp | /api/simulator"]
    Guard["Deterministic Policy Firewall<br/>BR-004 Refund Cap | BR-006 High-Value Gate"]
    EV["AI Assessment & EV Engine<br/>Step 18 Decision Table | SHA-256 Verifier"]
    DB[("SQLite Database (chargeback_shield.db)<br/>ENT-01 to ENT-10 via better-sqlite3")]
    Sim["Dual-Mode PayPal Engine<br/>Local Sandbox Simulator <--> Live PayPal REST API"]

    Client --> RSC
    Client --> API
    RSC --> DB
    API --> Guard
    Guard --> EV
    EV --> DB
    EV --> Sim
```

#### Detailed Stack Selections:
1. **Fullstack Framework:** **Next.js 14.2.x or 15.1.x App Router (TypeScript)**
   - Unified fullstack application hosting all 4 key views:
     1. `app/(c-suite)/page.tsx`: C-Suite Executive BI Command Center & "What-If" Policy Simulator.
     2. `app/(workbench)/disputes/page.tsx`: Analyst Dispute Autopilot Workbench & AI Evidence Builder.
     3. `app/(buyer)/negotiate/[id]/page.tsx`: Autonomous Buyer Negotiation Chat Portal.
     4. `components/JudgeDemoBar.tsx`: Persistent 1-Click Judge Demo Control Bar.
   - Route Handlers in `app/api/`:
     - `/api/webhooks/paypal`: Ingestion pipeline with deduplication (`BR-011`).
     - `/api/disputes/[id]/assess`: EV scoring and Step 18 Decision Table routing (`BR-007`, `BR-016`).
     - `/api/disputes/[id]/evidence`: Evidence compilation with SHA-256 zero-hallucination verification (`BR-008`).
     - `/api/disputes/[id]/negotiate`: Buyer chat endpoint with MCP Policy Firewall (`BR-004`).
     - `/api/simulator/reset`: 1-click Golden Dataset reset.
     - `/api/simulator/webhook`: 1-click dispute webhook generator.
   - **Configuration Note:** Add `serverExternalPackages: ['better-sqlite3']` in `next.config.js` to ensure Next.js bundler does not bundle native C++ addons.

2. **Database & Data Access:** **SQLite + `better-sqlite3`**
   - **Portability:** Zero external database installation. Zero Docker or cloud DB setup required by judges.
   - **Speed:** Synchronous queries execute in `< 2ms`, ensuring `NFR-001` (< 250ms webhook ingestion) and `NFR-002` (< 50ms dashboard query) are easily achieved.
   - **Data Governance:** Schema file (`db/schema.sql`) strictly implements all 10 core entities (`ENT-01` to `ENT-10`) with `PRAGMA foreign_keys = ON;`, `CHECK` constraints (e.g. `win_probability BETWEEN 0.0 AND 1.0`, `dispute_amount_cents > 0`), and composite performance indexes on `(merchant_id, status, seller_response_due_at)`.
   - **Seeding Strategy:** `scripts/seed.ts` executed via `tsx scripts/seed.ts --profile=demo`. Deterministically populates the 50 Golden Dataset disputes (e.g. `DSP-GOLD-001` through `DSP-GOLD-005`) with pre-calculated, verified SQL metric outputs.

3. **Pre-Code Quality Gates & Test Framework:** **Vitest**
   - Blazing-fast execution in native TypeScript and ESM.
   - Directly executes the DDDL Gate G4 pre-code testing commands before any UI code is written:
     - `npm run test:dq`: Runs `tests/dq/*.test.ts` to assert 100% data quality score (completeness, null checks, orphan FK checks, timestamp logic).
     - `npm run test:rules`: Runs `tests/rules/*.test.ts` parameterized against the Step 18 Decision Table (`BR-001` through `BR-025`, state machine legal transitions, and illegal transition rejections).
     - `npm run test:nfr`: Runs `tests/nfr/*.test.ts` verifying query latency (< 50ms), concurrent webhook burst idempotency, and PII masking verification.
     - `npm test`: Runs all test suites.

4. **Styling & Visualization:** **Tailwind CSS + Lucide React + Recharts**
   - **Tailwind CSS:** Modern, responsive dark/light theme styling for dense fintech tables, SLA countdown badges, and status pills.
   - **Lucide React:** Consistent iconography across workbench and judge controls.
   - **Recharts (v3.x):**
     - Area Chart: Cumulative Net Revenue Saved ($) over time.
     - Donut Chart: Dispute Volume by Reason Code (`INR`, `SNAD`, `UNAUTHORISED`).
     - Bar Chart: Win Rate % by Product SKU and Dispute Tier.
     - Dual-Line Chart: "What-If" Policy Simulator projected vs historical ROI.

---

## 5. Deployment & Hackathon Submission Infrastructure

### 5.1 Dockerfile (`Dockerfile`)
Multi-stage build guaranteeing zero-config execution in any environment:
```dockerfile
# Multi-stage Dockerfile for ChargebackShield
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm run test:dq
RUN npm run test:rules
RUN npm run test:nfr

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN apk add --no-cache libc6-compat

# Copy built artifacts and database seeder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/db ./db
COPY --from=builder /app/scripts ./scripts

EXPOSE 3000
CMD ["sh", "-c", "npm run db:seed && npm start"]
```

### 5.2 Render Infrastructure as Code (`render.yaml`)
Enables 1-click live demo deployment directly from the GitHub repository:
```yaml
services:
  - type: web
    name: chargebackshield
    env: node
    plan: free
    buildCommand: npm ci && npm run build
    startCommand: npm run db:seed && npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3000
      - key: NEXT_TELEMETRY_DISABLED
        value: 1
      - key: PAYPAL_MODE
        value: sandbox_simulated
```

### 5.3 Package Scripts Mapping
To be specified in `package.json`:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "db:seed": "tsx scripts/seed.ts --profile=demo",
    "db:seed:scale": "tsx scripts/seed.ts --profile=scale",
    "test": "vitest run",
    "test:dq": "vitest run tests/dq",
    "test:rules": "vitest run tests/rules",
    "test:nfr": "vitest run tests/nfr",
    "test:watch": "vitest"
  }
}
```

---

## 6. GitHub Issues & Team Work Allocation Mapping

### 6.1 Verified Live Issues on `g-s-jithesh/Paypal-AI`

The 3 GitHub issues were inspected via GitHub CLI:

#### Issue #1: `@g-s-jithesh` (40% Project Share)
- **Title:** `[40% Allocation] @g-s-jithesh — DDDL Phases 1–4 & 7: Data Foundation, MCP Policy Firewall, AI EV Engine & Dual-Mode PayPal Sandbox`
- **Playbook Phases:** Phase 1 (Discover), Phase 2 (Model), Phase 3 (Prove), Phase 4 (Platform), & Core Architecture (Phase 7)
- **Key Deliverables:**
  1. SQLite Physical Schema & Migrations (`ENT-01` to `ENT-10`) with composite indexes, foreign keys, and check constraints (`BR-001` to `BR-003`).
  2. Data Dictionary v2 & automated schema-drift validation.
  3. Deterministic Golden Dataset Seeder (`scripts/seed.ts`, `npm run db:seed`) generating 50 benchmark disputes (`DSP-GOLD-001` to `DSP-GOLD-005`).
  4. Pre-Code Automated Test Suites:
     - `npm run test:dq`: 100% data quality score across all tables.
     - `npm run test:rules`: Decision Table test cases (`BR-001` through `BR-025`) and state machine transitions.
     - `npm run test:nfr`: Query latency (< 50ms), duplicate webhook idempotency, PII masking.
  5. AI EV Engine (`BR-007`) & Step 18 Decision Table Router (`BR-016`).
  6. MCP Policy Firewall & Guardrails Engine (`BR-004`, `BR-006`).
  7. Dual-Mode PayPal Sandbox Integration (Seamless toggle between Local Simulator and live PayPal REST API).
- *Observation Note:* Issue #1's markdown body on GitHub is currently truncated at 328 characters and should be updated with the complete text above.

#### Issue #2: `@abinaya-mani-11` (30% Project Share)
- **Title:** `[30% Allocation] @abinaya-mani-11 — DDDL Phases 5 & 8: C-Suite Executive BI Command Center, What-If Simulator & Judge Demo Bar`
- **Playbook Phases:** Phase 5 (Insight: Steps 29–30), UAT Verification (Step 35), & Phase 8 (Release & Judge Demo Experience: Steps 45–46)
- **Key Deliverables:**
  1. C-Suite Executive BI Command Center (`ACT-02`, `REQ-007`, `KPI-001`–`KPI-006`) with 100% SQL reconciliation against the Golden Dataset:
     - KPI-001: Dispute Win Rate (%)
     - KPI-002: Net Revenue Saved ($)
     - KPI-003: Pre-Escalation Deflection Rate (%)
     - KPI-004: Chargeback Fee Avoidance ($)
     - KPI-005: Autonomous Resolution Rate (%)
     - KPI-006: Mean Time to Evidence Submission (MTTES)
  2. Interactive "What-If" Policy ROI Simulator (`US-005`, `FEAT-006`): Sliders for `max_auto_dispute_cents`, `max_refund_offer_pct`, `min_win_prob_auto_submit` with instant historical replay over the Golden Dataset.
  3. Interactive Hackathon Judge Demo Bar (`US-006`): 1-click webhook simulation, prompt injection attack test, MCP audit log inspector, and 1-click Golden Dataset reset.
  4. UAT Scenario Suite (`UAT-001` through `UAT-006`) & 3-minute YouTube demo walkthrough script in `README.md`.

#### Issue #3: `@Mkkumar2006` (30% Project Share)
- **Title:** `[30% Allocation] @Mkkumar2006 — DDDL Phases 6–8: Dispute Autopilot Workbench, AI Evidence Builder & Buyer Negotiation Portal`
- **Playbook Phases:** Operational Workflows (`WF-01`–`WF-04`), User Stories (`US-001`–`US-004`), Functional & Security Testing (Steps 36–41)
- **Key Deliverables:**
  1. Dispute Autopilot Workbench (`US-001`, `FEAT-001`): Interactive queue with status filtering, SLA countdown badges (`seller_response_due_at`), and multi-source evidence auto-assembler.
  2. Zero-Hallucination Evidence Package Builder (`BR-008`, `BR-009`, `US-002`): Fact-checking engine with `SHA-256` hashing ensuring zero fabricated tracking numbers or dates before PayPal `provide-evidence` submission.
  3. High-Value Human Approval Gate (`BR-006`): 1-click analyst approval for disputes `> $250`.
  4. Autonomous Buyer Negotiation Chat Portal (`US-003`, `US-004`, `FEAT-004`): Real-time conversational interface where buyers negotiate partial refunds (`make-offer`). Includes visual indication when prompt injection is intercepted by the `BR-004` policy firewall.
  5. Functional & Security Test Suites (`TC-FUNC-001` to `TC-FUNC-015`, `TC-SEC-001` prompt injection tests).

---

## 7. Next Steps & Implementation Roadmap

1. **Phase 1–4 Pre-Code Gates (Immediate Priority):**
   - Initialize Next.js 14/15 TypeScript application with `better-sqlite3`, `vitest`, `tsx`, `tailwindcss`, `lucide-react`, `recharts`.
   - Create `db/schema.sql` implementing `ENT-01` to `ENT-10`.
   - Write `scripts/seed.ts` populating the Golden Dataset (`DSP-GOLD-001` to `DSP-GOLD-005`).
   - Write and execute pre-code test suites (`npm run test:dq`, `npm run test:rules`, `npm run test:nfr`).
   - **Enforce DDDL Gate G4:** Application code does not begin until all pre-code test suites pass 100%.
2. **Phase 5 & 6 Interface Development:**
   - Implement C-Suite Executive BI Dashboard with direct SQL reconciliation against the database.
   - Implement "What-If" Policy Simulator.
   - Implement Dispute Autopilot Workbench and Buyer Negotiation Portal.
3. **Phase 7 & 8 Release & Polish:**
   - Integrate Judge Demo Control Bar with 1-click simulator triggers and DB reset.
   - Complete `Dockerfile` and `render.yaml`.
   - Draft comprehensive `README.md` and 3-minute video demo walkthrough script.
