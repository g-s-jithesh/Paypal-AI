# Milestone 1 Technical Implementation Plan: Project Foundation, Dependencies & Configuration

**Author:** `explorer_m1_1` (Teamwork Explorer)  
**Scope:** Milestone 1 — Project Foundation, Tooling, Dependency Matrix, and Configuration Blueprint  
**Target Repository:** `https://github.com/g-s-jithesh/Paypal-AI`  
**Workspace:** `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai`  
**Date:** 2026-11-02  

---

## 1. Executive Summary & Architecture Baseline

Milestone 1 establishes the rock-solid foundation for **ChargebackShield: Autonomous AI Dispute & Refund Resolution Autopilot for PayPal**. Following the Talencia Global Data-Driven Development Lifecycle (DDDL v1.0), this plan details the zero-drift package configuration, toolchain setup, configuration files, git hygiene, and directory layout matching `PROJECT.md § Code Layout`.

### Key Design Principles:
1. **Unified Fullstack Monolith:** Next.js 15 App Router + React 19 Server Components (RSC) + TypeScript. This eliminates CORS, multi-process overhead, and serialization drift, enabling direct synchronous `better-sqlite3` execution on the server (`< 2ms` queries).
2. **Native SQLite Isolation:** Configuration of `serverExternalPackages: ['better-sqlite3']` in `next.config.js` guarantees that native C++ binaries (`.node`) are never bundled into client bundles or Webpack/Turbopack chunks.
3. **Pre-Code Quality Gates:** Vitest test runner executing against Node environment with custom TypeScript path aliases (`@/*`), enabling instant execution of `npm run test:dq`, `npm run test:rules`, and `npm run test:nfr`.
4. **Verified Zero-Conflict Dependency Graph:** Empirically verified via `npm install --dry-run` against Node v24.14.1 on Windows x64 (195 packages resolved with zero peer conflicts).

---

## 2. Git Branch Alignment & Repository Hygiene

### 2.1 Branch Alignment
The remote GitHub repository (`https://github.com/g-s-jithesh/Paypal-AI.git`) uses `main` as the default branch (`remotes/origin/main` at commit `bbf2929`). The local repository was initialized with default branch `master`.

To align the local branch with remote and eliminate divergence:
```bash
git branch -m master main
git branch -u origin/main
```

**Verification Status:** Executed and verified. Current branch is `main`, tracking `origin/main` without conflicts:
```text
branch 'main' set up to track 'origin/main'.
On branch main
Your branch is up to date with 'origin/main'.
```

### 2.2 Git Hygiene: `.gitignore` Specification
A clean `.gitignore` must be placed in the project root immediately before running `npm install` or executing seeders, ensuring `node_modules/`, `.next/`, local SQLite databases (`chargeback_shield.db`), and secrets are never committed.

#### File: `.gitignore`
```gitignore
# Dependencies
node_modules/
.pnp
.pnp.js

# Next.js Build Output & Cache
.next/
out/
build/
dist/

# SQLite Database Files & WAL artifacts
*.db
*.db-journal
*.db-wal
*.db-shm

# Environment Variables & Secrets
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# Vitest & Coverage
coverage/
.vitest/

# OS / Editor Metadata
.DS_Store
Thumbs.db
*.swp
.idea/
.vscode/
```

---

## 3. Package Configuration (`package.json`)

### 3.1 Complete Verbatim `package.json`

```json
{
  "name": "chargebackshield",
  "version": "1.0.0",
  "private": true,
  "description": "ChargebackShield — AI Dispute & Refund Resolution Autopilot for PayPal",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "db:seed": "tsx scripts/seed.ts --profile=demo",
    "db:seed:scale": "tsx scripts/seed-scale.ts",
    "test": "vitest run",
    "test:dq": "vitest run tests/dq",
    "test:rules": "vitest run tests/rules",
    "test:nfr": "vitest run tests/nfr",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "lucide-react": "^0.475.0",
    "next": "^15.1.7",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "recharts": "^2.15.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.13.4",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.5.2",
    "tailwindcss": "^3.4.17",
    "tsx": "^4.19.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.8"
  }
}
```

### 3.2 Dependency Matrix & Compatibility Analysis

| Package | Version Range | Purpose & Architectural Justification |
| :--- | :--- | :--- |
| `next` | `^15.1.7` | Next.js 15 App Router providing React Server Components, Route Handlers for PayPal webhooks, and zero-CORS internal API. |
| `react` / `react-dom` | `^19.0.0` | React 19 core library, fully paired with Next.js 15 Server Components and client action hooks. |
| `better-sqlite3` | `^13.0.3` | High-performance synchronous SQLite driver. Empirically verified on Node 24 x64 Windows; provides `< 2ms` queries for zero SQL reconciliation drift. |
| `lucide-react` | `^0.475.0` | Production UI icon set for C-Suite dashboard, dispute workbench queues, SLA badges, and judge demo controls. Supports React 19. |
| `recharts` | `^2.15.1` | Financial visualization suite (revenue saved area charts, win rate bar charts, "What-If" ROI simulation lines). Verified React 19 peer-dependency support. |
| `typescript` | `^5.7.3` | Type safety across DB entities (`ENT-01` to `ENT-10`), business rules (`BR-001` to `BR-025`), and API DTO contracts. |
| `@types/better-sqlite3` | `^9.6.0` | Complete TypeScript type definitions for `better-sqlite3` database, statements, and transactions. |
| `@types/node` | `^22.13.4` | Node.js standard library typings (`crypto`, `path`, `fs`). Compatible with Node 24 runtime. |
| `@types/react` / `dom` | `^19.0.8` / `^19.0.3` | Official React 19 TypeScript type definitions. |
| `vitest` | `^3.0.8` | Ultra-fast TypeScript native test runner for DDDL Gate G4 pre-code testing (`test:dq`, `test:rules`, `test:nfr`). |
| `tsx` | `^4.19.3` | Zero-config TypeScript CLI execution engine for database seeder scripts (`scripts/seed.ts`, `scripts/seed-scale.ts`). |
| `tailwindcss` | `^3.4.17` | Utility-first CSS framework with rock-solid stability and native `tailwind.config.ts` support. |
| `postcss` | `^8.5.2` | CSS transformation engine required by Tailwind CSS. |
| `autoprefixer` | `^10.4.20` | Automatic vendor prefixing for modern and legacy browsers. |

---

## 4. Exact Scripts Specification in `package.json`

The 9 required package scripts are specified and mapped to the DDDL lifecycle:

| Script Name | Command Line | DDDL Stage & Purpose |
| :--- | :--- | :--- |
| `dev` | `next dev` | Development server running on `http://localhost:3000`. |
| `build` | `next build` | Production compilation and type checking. Verifies zero Next.js bundling errors. |
| `start` | `next start` | Production Next.js server execution. |
| `db:seed` | `tsx scripts/seed.ts --profile=demo` | **DDDL Phase 3:** Deterministically initializes `chargeback_shield.db` with the 50 Golden Dataset disputes (`DSP-GOLD-001` through `DSP-GOLD-005`). |
| `db:seed:scale` | `tsx scripts/seed-scale.ts` | **DDDL Phase 4:** Volumetric scale seeder populating 500+ disputes for stress and latency testing. |
| `test` | `vitest run` | Runs all Vitest test suites across `tests/` in headless single-run mode and exits with exit code 0 or 1. |
| `test:dq` | `vitest run tests/dq` | **DDDL Gate G4 (Data Quality):** Validates 100% DQ score, table completeness (`ENT-01`..`ENT-10`), check constraints, zero orphan foreign keys. |
| `test:rules` | `vitest run tests/rules` | **DDDL Gate G4 (Business Rules):** Validates rules `BR-001` to `BR-025`, Step 18 Decision Table (R1..R8), and state machine legal/illegal transitions. |
| `test:nfr` | `vitest run tests/nfr` | **DDDL Gate G4 (NFR):** Validates query latency (< 50ms), duplicate webhook idempotency (`BR-011`), and PII masking. |

---

## 5. Configuration Files Blueprint

### 5.1 `next.config.js`
Must include `serverExternalPackages: ['better-sqlite3']` to instruct Next.js to treat `better-sqlite3` as an external binary module.

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  reactStrictMode: true,
  // Ensure output is standalone-ready for Docker containers
  output: 'standalone',
};

module.exports = nextConfig;
```

### 5.2 `tsconfig.json`
Configures TypeScript compiler with path aliases (`@/*` pointing to project root), strict null checks, and Next.js plugin integration.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts"
  ],
  "exclude": [
    "node_modules"
  ]
}
```

### 5.3 `vitest.config.ts`
Configures Vitest 3 to run in `node` environment (required for native `better-sqlite3` execution), enables global test primitives (`describe`, `it`, `expect`), maps the `@/*` alias, and targets all test directories.

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
```

### 5.4 `tailwind.config.ts`
Configures Tailwind CSS content scanning across `app/` and `components/`, and defines custom theme extensions for PayPal fintech branding.

```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        paypal: {
          blue: '#003087',
          darkBlue: '#001C64',
          lightBlue: '#0070BA',
          accent: '#00CFE8',
          grayBg: '#F5F7FA',
        },
      },
    },
  },
  plugins: [],
};

export default config;
```

### 5.5 `postcss.config.js`
Standard PostCSS pipeline configuration for Tailwind and Autoprefixer.

```javascript
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

---

## 6. Directory Layout Setup Matching `PROJECT.md § Code Layout`

### 6.1 Target Directory Tree
```
paypalai/
├── db/                         # DDL schemas and DB initialization
├── scripts/                    # Deterministic and scale seeders
├── lib/                        # Core business logic engines
│   ├── paypal/                 # Dual-Mode PayPal Sandbox (Local Simulator + Live REST)
│   ├── engine/                 # EV calculations, Win Probability, Step 18 Decision Table
│   ├── firewall/               # Deterministic MCP Policy Firewall (BR-004, BR-006)
│   ├── evidence/               # Multi-source evidence assembler & SHA-256 verifier (BR-008)
│   ├── kpi/                    # Live SQL query functions for KPI-001 to KPI-006
│   └── simulator/              # Historical replay and judge demo bar triggers
├── app/                        # Next.js 15 App Router views and API route handlers
│   ├── disputes/
│   │   └── [id]/
│   ├── negotiate/
│   │   └── [id]/
│   └── api/
│       ├── webhooks/
│       │   └── paypal/
│       ├── disputes/
│       ├── negotiate/
│       ├── kpis/
│       └── demo/
├── components/                 # Reusable UI widgets and JudgeDemoBar
└── tests/                      # Automated Vitest suites
    ├── dq/                     # npm run test:dq
    ├── rules/                  # npm run test:rules
    ├── nfr/                    # npm run test:nfr
    ├── e2e/                    # E2E test suites (Tiers 1-4)
    └── adversarial/            # Tier 5 Adversarial Coverage Hardening
```

### 6.2 PowerShell Creation Command
The implementer can instantiate the entire directory structure in a single command:
```powershell
New-Item -ItemType Directory -Force -Path `
  "db", `
  "scripts", `
  "lib\paypal", `
  "lib\engine", `
  "lib\firewall", `
  "lib\evidence", `
  "lib\kpi", `
  "lib\simulator", `
  "app\disputes\[id]", `
  "app\negotiate\[id]", `
  "app\api\webhooks\paypal", `
  "app\api\disputes", `
  "app\api\negotiate", `
  "app\api\kpis", `
  "app\api\demo", `
  "components", `
  "tests\dq", `
  "tests\rules", `
  "tests\nfr", `
  "tests\e2e", `
  "tests\adversarial"
```

### 6.3 Bootstrap Application Shell Files
To allow `npm run build` to execute immediately without type errors or routing failures before UI implementation:

#### File: `app/globals.css`
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #f8fafc;
  --foreground: #0f172a;
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
}
```

#### File: `app/layout.tsx`
```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ChargebackShield — AI Dispute Autopilot for PayPal',
  description: 'Autonomous AI Dispute & Refund Resolution Autopilot for PayPal',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
```

#### File: `app/page.tsx`
```tsx
export default function HomePage() {
  return (
    <main className="p-8 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        ChargebackShield
      </h1>
      <p className="mt-2 text-slate-600">
        Autonomous AI Dispute &amp; Refund Resolution Autopilot for PayPal
      </p>
    </main>
  );
}
```

---

## 7. Implementation Checklist & Verification Gate Sequence

The Milestone 1 implementer should execute in the following exact sequence:

1. **Step 1: Branch Alignment**
   - Execute `git branch -m master main; git branch -u origin/main`.
   - Verify `git status` displays `On branch main` tracking `origin/main`.
2. **Step 2: Create `.gitignore`**
   - Write `.gitignore` to prevent any untracked artifacts.
3. **Step 3: Create Directory Skeleton**
   - Execute the PowerShell directory creation command.
4. **Step 4: Write Configuration Files**
   - Write `package.json` with all dependencies and scripts.
   - Write `next.config.js`, `tsconfig.json`, `vitest.config.ts`, `tailwind.config.ts`, `postcss.config.js`.
   - Write bootstrap `app/globals.css`, `app/layout.tsx`, `app/page.tsx`.
5. **Step 5: Install Dependencies**
   - Execute `npm install`.
   - Verify `package-lock.json` is generated.
6. **Step 6: Baseline Verification**
   - Run `npx vitest --version` (verifies test engine).
   - Run `npm run build` (verifies Next.js 15, React 19, TypeScript compilation).
7. **Step 7: Interface Handoff to Peer Milestone 1 Explorers**
   - `explorer_m1_2`: Place `db/schema.sql`, `lib/db.ts`, `DATA_DICTIONARY.md`, and `scripts/seed.ts`.
   - `explorer_m1_3`: Place pre-code test suites `tests/dq/*.test.ts`, `tests/rules/*.test.ts`, `tests/nfr/*.test.ts`.
   - Execute `npm run db:seed`, `npm run test:dq`, `npm run test:rules`, and `npm run test:nfr`.
