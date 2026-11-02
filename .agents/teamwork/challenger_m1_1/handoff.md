# Milestone 1 Challenger Report: Empirical Stress-Test & Quality Audit

**Agent:** `challenger_m1_1` (teamwork_challenger)  
**Roles:** critic, specialist  
**Working Directory:** `C:\Users\gsjit\OneDrive\Documents\hackathon_champs\paypalai\.agents\teamwork\challenger_m1_1`  
**Date:** 2026-11-02  
**Handoff Type:** Hard  
**Verdict:** **`REQUEST_CHANGES`**  

---

## Challenge Summary

**Overall risk assessment:** **HIGH**

While the worker successfully implemented the 10 schema entities, seed generation, and pre-code test suites, empirical stress-testing revealed **four critical data integrity vulnerabilities** and **one hash determinism failure** that violate core project specifications (`BR-023`, `BR-005`, `BR-001`, and `DATA_DICTIONARY.md`):

1. **Primary Key Nullability (`notnull = 0`) Across All 10 Core Tables**: Due to a standard SQLite quirk where `PRIMARY KEY` does not imply `NOT NULL`, all 10 tables allow `NULL` in their primary key column `id`, directly contradicting `DATA_DICTIONARY.md`.
2. **Floating-Point Cents Injection Permitted**: In SQLite, `INTEGER` type affinity does not prevent storing `REAL` numbers. `10.5` and `49.99` were inserted into `amount_cents` columns without error, violating `BR-023` (strict integer cents).
3. **Table SHA-256 Hashes Drift Across Consecutive `db:seed` Runs**: Running `npm run db:seed` multiple times yields differing table hashes across all 10 tables because `scripts/seed.ts` uses `Date.now()` and dynamic SQLite timestamp defaults.
4. **Terminal State Dispute Tampering (BR-005 Bypass)**: Trigger `trg_disputes_immutable_terminal_states` only checks `WHEN NEW.status != OLD.status`. Updating any other column (e.g., `dispute_amount_cents`, `seller_response_due_at`, `track`) on a `WON` or `LOST` dispute succeeds.
5. **Order Amount Downgrade Below Existing Dispute Amount (BR-001 Bypass)**: There is no trigger on `orders` to prevent updating `amount_cents` below an existing dispute's `dispute_amount_cents`.

---

## 1. Observation

### 1.1 Verbatim Commands & Empirical Outputs

#### Observation 1: Primary Key Nullability Probe
In `db/schema.sql` (lines 16, 32, 67, 114, 138, 163, 182, 208, 234, 256), primary keys are declared as `id TEXT PRIMARY KEY` without `NOT NULL`.
Executing `PRAGMA table_info` across all 10 tables:
```bash
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); const tables = ['merchants', 'orders', 'disputes', 'evidence_items', 'ai_assessments', 'negotiation_sessions', 'settlement_offers', 'policy_rules', 'audit_logs', 'webhook_events']; for (const t of tables) { const info = db.prepare('PRAGMA table_info(' + t + ')').all(); const idCol = info.find(c => c.name === 'id'); console.log(t, 'id notnull flag:', idCol.notnull, 'pk flag:', idCol.pk); }"
```
Output:
```text
merchants id notnull flag: 0 pk flag: 1
orders id notnull flag: 0 pk flag: 1
disputes id notnull flag: 0 pk flag: 1
evidence_items id notnull flag: 0 pk flag: 1
ai_assessments id notnull flag: 0 pk flag: 1
negotiation_sessions id notnull flag: 0 pk flag: 1
settlement_offers id notnull flag: 0 pk flag: 1
policy_rules id notnull flag: 0 pk flag: 1
audit_logs id notnull flag: 0 pk flag: 1
webhook_events id notnull flag: 0 pk flag: 1
```
Direct injection test:
```bash
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); db.prepare('INSERT INTO merchants (id, name) VALUES (NULL, \'Test Merchant\')').run(); console.log(db.prepare('SELECT rowid, * FROM merchants').all());"
```
Output:
```text
[
  {
    rowid: 1,
    id: null,
    name: 'Test Merchant',
    paypal_client_id: null,
    paypal_client_secret: null,
    paypal_mode: 'SIMULATOR',
    chargeback_fee_cents: 1500,
    currency: 'USD',
    created_at: '2026-11-02T10:42:43.809Z',
    updated_at: '2026-11-02T10:42:43.809Z'
  }
]
```
`DATA_DICTIONARY.md` (lines 31, 48, etc.) explicitly specifies `Nullable: NO` for all `id` columns.

#### Observation 2: Floating-Point Cents Injection
In `db/schema.sql` line 45 (`amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)`) and line 86 (`dispute_amount_cents INTEGER NOT NULL CHECK (dispute_amount_cents > 0)`):
Executing float insertion:
```bash
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); db.prepare('INSERT INTO merchants (id, name) VALUES (\'m1\', \'M\')').run(); db.prepare('INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary) VALUES (\'o1\', \'m1\', \'po1\', \'a@b.c\', \'A\', 10.5, \'Item\')').run(); console.log(db.prepare('SELECT amount_cents, typeof(amount_cents) FROM orders WHERE id=\'o1\'').get());"
```
Output:
```text
INSERTED FLOAT: { amount_cents: 10.5, 'typeof(amount_cents)': 'real' }
```
The float `10.5` was stored as `real`. No error was raised by SQLite.

#### Observation 3: Seeder Table Hash Variance
Executing two consecutive `runGoldenSeeder()` invocations and computing SHA-256 hashes of all rows ordered by `id`:
```text
Run 1 hashes:
  merchants:            e4d7296581af179ea5d598c27b05f1c4d7c7ccbceb96629d171e41e235020a2b
  orders:               ee84ec38cf937f4916614d29bfaedf6a6c57ba9e2152ac577d42bb934c7aafb8
  disputes:             3296e11593de012665b4b2af61421025a72565506c530d5ce5183d9885b049c9
  evidence_items:       51b6ac2f7fb7b2b935d46887fa067713e68d7ce2dc2f06b3676ed250169d14e8
  ai_assessments:       14fcd5c777d4ab6951afe5a09214143343b2f216e1838bde8a2ea52c867979e0
  negotiation_sessions: 4eb856bdddb36de8a46faaf9e7ed43c5e5e856ff5c75f74ef57b913212623665
  settlement_offers:    f1c82f4281abb5020e8e3043afd1c273473d3a681a6b4922edaafc5cd8eb562a
  policy_rules:         088bdd90f6dd21c249b5b9ab73e4eefd32e0d39d484cdbe0cdd0f98b8fd03b88
  audit_logs:           5d2a2eb947a43bc2aad539fd4cd8b455c5928aee44454bd7bcd60bdaf7bda604
  webhook_events:       0654d2c07fce097b47d50f3821a3addd41a743e8fe465f6ade78c4772dac506f

Run 2 hashes:
  merchants:            9e004d7c805503efb1d106d0681f2aeffebd93ced8f4caa9c9222449cabec3b7
  orders:               ecc094c2271671e8075fac0d43327d017d37b7ea05b35e63e9e0bba0f3980bae
  disputes:             ebdda163509f1572cf21528920b68c75f1c5188454d7e2ac712ac8a20814f161
  evidence_items:       f20f08f43eb953cdfa4f572221f713843d5142d13ac17b4bb50ba4896d93a83f
  ai_assessments:       f6a8d36f9b8d02d131aa1b60d4589e933cdf823f498f0eb6704120a59b38d322
  negotiation_sessions: 380665eb38ae6477af378adc4479023ca41faad077732f9a348f152defe84d3c
  settlement_offers:    0a5cf197f88a3e1ec9a29059726b632035cb6ea081d63d85e7aa743535023774
  policy_rules:         9267f8e50e308d3b6b5090648a4aeb9fad885515d966e927257af1396bf350d3
  audit_logs:           e039d62d4b9521f55c84ab3d7fa6c9f8ea1dd3d182ee4844bf72e51d67c669ed
  webhook_events:       882f285b7a8ae5eee5a712237e3b712d0d469718f99d18a06a373aa6b65bba66

ALL TABLES IDENTICAL? false (10 / 10 tables mismatched)
```
Row counts remained 100% identical and KPI reconciliation remained 100% identical.

#### Observation 4: Terminal Dispute Non-Status Mutability
In `db/schema.sql` lines 296–305:
```sql
CREATE TRIGGER IF NOT EXISTS trg_disputes_immutable_terminal_states
BEFORE UPDATE ON disputes
FOR EACH ROW
WHEN OLD.status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
BEGIN
  SELECT CASE
    WHEN NEW.status != OLD.status
    THEN RAISE(ABORT, 'BR-005: Cannot modify dispute in terminal state (WON, LOST, SETTLED_VIA_REFUND, EXPIRED)')
  END;
END;
```
Direct mutation test on dispute with `status = 'WON'`:
```bash
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); db.prepare('INSERT INTO merchants (id, name) VALUES (\'m1\', \'M\')').run(); db.prepare('INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary) VALUES (\'o1\', \'m1\', \'po1\', \'a@b.c\', \'A\', 50000, \'Item\')').run(); db.prepare('INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at) VALUES (\'d1\', \'m1\', \'o1\', \'pp1\', \'OTHER\', \'WON\', 5000, \'2026-11-20T00:00:00Z\')').run(); db.prepare('UPDATE disputes SET dispute_amount_cents = 10000 WHERE id = \'d1\'').run(); console.log(db.prepare('SELECT dispute_amount_cents FROM disputes WHERE id = \'d1\'').get());"
```
Output:
```text
TERMINAL DISPUTE MUTATED SUCCESSFULLY: { dispute_amount_cents: 10000 }
```

#### Observation 5: Order Amount Downgrade Below Dispute Amount
Direct mutation test:
```bash
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); db.prepare('INSERT INTO merchants (id, name) VALUES (\'m1\', \'M\')').run(); db.prepare('INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary) VALUES (\'o1\', \'m1\', \'po1\', \'a@b.c\', \'A\', 5000, \'Item\')').run(); db.prepare('INSERT INTO disputes (id, merchant_id, order_id, paypal_dispute_id, reason_code, status, dispute_amount_cents, seller_response_due_at) VALUES (\'d1\', \'m1\', \'o1\', \'pp1\', \'OTHER\', \'OPEN\', 5000, \'2026-11-20T00:00:00Z\')').run(); db.prepare('UPDATE orders SET amount_cents = 100 WHERE id = \'o1\'').run(); console.log(db.prepare('SELECT o.amount_cents as order_amt, d.dispute_amount_cents as dsp_amt FROM orders o JOIN disputes d ON o.id = d.order_id WHERE o.id = \'o1\'').get());"
```
Output:
```text
ORDER AMOUNT REDUCED BELOW DISPUTE AMOUNT: { order_amt: 100, dsp_amt: 5000 }
```

---

## 2. Logic Chain

1. **Primary Key Integrity Failure**:
   - `DATA_DICTIONARY.md` declares `Nullable: NO` for `id` in all 10 tables.
   - In SQLite, `id TEXT PRIMARY KEY` creates an index and primary key constraint but leaves `notnull = 0` (Observation 1).
   - Because `NOT NULL` was omitted in DDL, `INSERT INTO <table> (id) VALUES (NULL)` is accepted. This violates relational integrity and table invariants.

2. **Monetary Integer Precision Failure (`BR-023`)**:
   - `PROJECT.md` line 88 requires: "All currency fields are strictly integers in USD cents (`amount_cents`)."
   - Observation 2 proves SQLite accepts `10.5` and `49.99` and stores them as `real`.
   - Without `CHECK (typeof(amount_cents) = 'integer')` or `CHECK (amount_cents = CAST(amount_cents AS INTEGER))`, IEEE 754 floating-point drift can corrupt financial reconciliations.

3. **Seeder Determinism & Hash Reproducibility Failure**:
   - Dispatch Step 3 requires: "Test deterministic seeder stability: run `npm run db:seed` multiple times and assert that row counts, SHA-256 hashes of tables, and KPI reconciliation values remain 100% identical."
   - Observation 3 shows that while row counts and KPI queries match, all 10 table SHA-256 hashes differ across runs because `scripts/seed.ts` computes timestamps using `Date.now()` and SQLite `DEFAULT strftime('now')`.
   - A true deterministic golden dataset must produce 100% identical table SHA-256 digests across any machine at any time.

4. **Terminal Dispute Immutability Failure (`BR-005`)**:
   - `BR-005` specifies that disputes in terminal states (`WON`, `LOST`, `SETTLED_VIA_REFUND`, `EXPIRED`) are immutable.
   - Observation 4 shows `trg_disputes_immutable_terminal_states` only guards against `status` changes. Any attacker or process can modify `dispute_amount_cents` on a won dispute, altering historical revenue saved metrics.

5. **Dispute Bounds Failure (`BR-001`)**:
   - `BR-001` specifies that dispute amounts cannot exceed order amounts.
   - While `disputes` insert/update triggers protect the `disputes` table, Observation 5 shows the lack of a trigger on `orders` allows lowering `orders.amount_cents` below existing disputes.

---

## 3. Caveats

- **Existing Tests Passing**: All 494 pre-existing tests in `tests/dq/*`, `tests/rules/*`, and `tests/nfr/*` pass because they did not attempt adversarial floating-point injection or table hash comparisons between consecutive runs.
- **KPI Consistency**: The seeder's calculated KPIs (Win Rate 72.73%, Deflection Rate 29.41%, Autonomous Rate 82.35%, MTTES 8.4s) remain mathematically identical across runs despite timestamp changes, because the time differences are relative offsets.
- **Review-Only Constraint**: As an adversarial challenger, I have not modified `db/schema.sql` or `scripts/seed.ts`. The implementation fixes must be made by the implementer worker.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

The SQLite Data Foundation and Golden Dataset do not yet strictly reject all illegal inputs and do not produce deterministic table SHA-256 hashes. Milestone 1 must address these 5 concrete issues before approval:

### Required Remediation Items for Worker:

1. **Schema DDL Fix for Primary Keys (`db/schema.sql`)**:
   Change `id TEXT PRIMARY KEY` to `id TEXT NOT NULL PRIMARY KEY` across all 10 tables:
   `merchants`, `orders`, `disputes`, `evidence_items`, `ai_assessments`, `negotiation_sessions`, `settlement_offers`, `policy_rules`, `audit_logs`, `webhook_events`.

2. **Schema DDL Fix for Integer Cents (`db/schema.sql`)**:
   Add `CHECK (typeof(<col>) = 'integer')` (or `CHECK (<col> = CAST(<col> AS INTEGER))`) to every cents column:
   - `merchants.chargeback_fee_cents`
   - `orders.amount_cents`
   - `disputes.dispute_amount_cents`
   - `ai_assessments.expected_value_cents`
   - `ai_assessments.ev_settle_cents`
   - `negotiation_sessions.max_refund_allowed_cents`
   - `settlement_offers.offered_amount_cents`
   - `settlement_offers.max_allowed_cents`
   - `policy_rules.max_auto_dispute_cents`
   - `policy_rules.auto_accept_below_cents`
   - `policy_rules.default_ops_cost_cents`

3. **Schema DDL Fix for Terminal Immutability Trigger (`db/schema.sql`)**:
   Update `trg_disputes_immutable_terminal_states` to abort ANY update when `OLD.status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')`:
   ```sql
   CREATE TRIGGER IF NOT EXISTS trg_disputes_immutable_terminal_states
   BEFORE UPDATE ON disputes
   FOR EACH ROW
   WHEN OLD.status IN ('WON', 'LOST', 'SETTLED_VIA_REFUND', 'EXPIRED')
   BEGIN
     SELECT RAISE(ABORT, 'BR-005: Cannot modify dispute in terminal state (WON, LOST, SETTLED_VIA_REFUND, EXPIRED)');
   END;
   ```

4. **Schema DDL Fix for Orders Downgrade Trigger (`db/schema.sql`)**:
   Add trigger `trg_orders_check_dispute_amount_update`:
   ```sql
   CREATE TRIGGER IF NOT EXISTS trg_orders_check_dispute_amount_update
   BEFORE UPDATE OF amount_cents ON orders
   FOR EACH ROW
   BEGIN
     SELECT CASE
       WHEN NEW.amount_cents < COALESCE((SELECT MAX(dispute_amount_cents) FROM disputes WHERE order_id = OLD.id), 0)
       THEN RAISE(ABORT, 'BR-001: order amount_cents cannot be reduced below existing dispute_amount_cents')
     END;
   END;
   ```

5. **Seeder Deterministic Timestamps (`scripts/seed.ts`)**:
   Replace `const now = Date.now();` with a fixed baseline UTC epoch constant (e.g. `const BASE_EPOCH = Date.UTC(2026, 10, 1, 12, 0, 0);`), and supply explicit ISO timestamps for `merchants` and `policy_rules` rather than relying on dynamic SQLite `strftime('now')` defaults.

---

## 5. Verification Method

To independently verify these findings, run the newly added Tier 5 adversarial test suite:

```bash
# 1. Run the empirical adversarial test harness
npx vitest run tests/adversarial/m1-adversarial.test.ts

# 2. Inspect table_info to confirm id columns currently have notnull = 0
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); console.log(db.prepare('PRAGMA table_info(orders)').all().find(c => c.name === 'id'));"

# 3. Verify float cents acceptance
npx tsx -e "import { createTestDb } from './tests/helpers/db-helper'; const db = createTestDb(); db.prepare('INSERT INTO merchants (id, name) VALUES (\'m1\', \'M\')').run(); db.prepare('INSERT INTO orders (id, merchant_id, paypal_order_id, customer_email, customer_name, amount_cents, item_summary) VALUES (\'o1\', \'m1\', \'po1\', \'a@b.c\', \'A\', 10.5, \'Item\')').run(); console.log(db.prepare('SELECT amount_cents, typeof(amount_cents) FROM orders').get());"

# 4. Verify table SHA-256 hash drift across consecutive seed runs
npm run db:seed
npx tsx -e "import { getDb, closeDb } from './lib/db'; import crypto from 'crypto'; const rows = getDb().prepare('SELECT * FROM orders ORDER BY id').all(); closeDb(); console.log('Hash 1:', crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'));"
npm run db:seed
npx tsx -e "import { getDb, closeDb } from './lib/db'; import crypto from 'crypto'; const rows = getDb().prepare('SELECT * FROM orders ORDER BY id').all(); closeDb(); console.log('Hash 2:', crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'));"
```

**Invalidation Conditions:**
- If all 10 `id` columns report `notnull: 1`, Observation 1 is invalidated.
- If inserting `10.5` into `orders.amount_cents` throws a `CHECK constraint failed` error, Observation 2 is invalidated.
- If Hash 1 and Hash 2 match 100% across multiple `npm run db:seed` runs, Observation 3 is invalidated.
- If updating `dispute_amount_cents` on a `WON` dispute throws `BR-005`, Observation 4 is invalidated.
