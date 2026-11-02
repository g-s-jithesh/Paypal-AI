# ChargebackShield Data Dictionary v2

**Version:** 2.0.0  
**Project:** ChargebackShield (AI Dispute & Refund Resolution Autopilot for PayPal)  
**Database Engine:** SQLite 3 (WAL mode enabled, `PRAGMA foreign_keys = ON;`)  
**Monetary Standard:** All currencies stored as strictly non-negative integer cents (`amount_cents`, `dispute_amount_cents`, `offered_amount_cents`, `chargeback_fee_cents`, `expected_value_cents`). Floating-point money is prohibited (`BR-023`).  
**Lifecycle Standard:** Talencia Global Data-Driven Development Lifecycle (DDDL v1.0) Steps 06–25  

---

## 1. Data Classification & Privacy Governance

All attributes are classified according to privacy and security risk profiles:

| Classification | Definition | Handling & Masking Rules |
| :--- | :--- | :--- |
| **`PUBLIC`** | System identifiers, dispute status codes, reason enums, PayPal IDs. | Can be displayed without redaction. |
| **`INTERNAL`** | Merchant configurations, expected values ($EV$), confidence scores, policy thresholds. | Restricted to authenticated merchant portal. |
| **`CONFIDENTIAL/PII`** | Customer direct identifiers (name, email, shipping address, delivery signature, IP address). | Must be masked/tokenized before LLM prompt assembly (`BR-013`). |
| **`RESTRICTED`** | PayPal API secrets, client IDs, buyer portal access token hashes (`token_hash`). | Strictly isolated; never logged or exposed in client responses. |

---

## 2. Entity Specifications (ENT-01 to ENT-10)

### 1. `merchants` (`ENT-01`)
Merchant configuration, PayPal Sandbox credentials, and fee baseline.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Unique merchant identifier (`'merch_default'`) |
| `name` | `TEXT` | NO | — | `CHECK (LENGTH(name) > 0)` | — | `INTERNAL` | Registered merchant store name |
| `paypal_client_id` | `TEXT` | YES | `NULL` | — | — | `RESTRICTED` | PayPal REST Client ID |
| `paypal_client_secret` | `TEXT` | YES | `NULL` | — | — | `RESTRICTED` | PayPal REST Secret (Never logged) |
| `paypal_mode` | `TEXT` | NO | `'SIMULATOR'` | `CHECK (IN ('SIMULATOR','SANDBOX','LIVE'))` | — | `INTERNAL` | Engine execution mode flag |
| `chargeback_fee_cents` | `INTEGER` | NO | `1500` | `CHECK (chargeback_fee_cents >= 0 AND typeof(chargeback_fee_cents) = 'integer')` | — | `INTERNAL` | Bank dispute penalty fee (1500 = $15.00) |
| `currency` | `TEXT` | NO | `'USD'` | `CHECK (IN ('USD','EUR','GBP'))` | — | `INTERNAL` | Default account currency |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Record creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Record modification timestamp |

---

### 2. `orders` (`ENT-02`)
Orders synced from PayPal Orders v2 with carrier tracking checkpoints.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Internal order ID (`'ORD-GOLD-001'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Associated merchant identifier |
| `paypal_order_id` | `TEXT` | NO | — | `UNIQUE` | — | `INTERNAL` | PayPal Order v2 ID (`'O-991001'`) |
| `capture_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | PayPal Capture transaction ID |
| `customer_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Customer account identifier |
| `customer_email` | `TEXT` | NO | — | — | — | `CONFIDENTIAL/PII` | Customer email (Masked in LLM prompts) |
| `customer_name` | `TEXT` | NO | — | — | — | `CONFIDENTIAL/PII` | Customer full name |
| `shipping_address_line1` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Street delivery address |
| `shipping_city` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Destination city |
| `shipping_state` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Destination state code (e.g. `'CA'`) |
| `shipping_postal_code` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Postal / ZIP code |
| `shipping_country` | `TEXT` | NO | `'US'` | `LENGTH(shipping_country) = 2` | — | `INTERNAL` | ISO 3166-1 alpha-2 country |
| `currency` | `TEXT` | NO | `'USD'` | — | — | `INTERNAL` | Order currency |
| `amount_cents` | `INTEGER` | NO | — | `CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer')` | — | `INTERNAL` | Captured total amount in cents (14500 = $145.00) |
| `carrier_name` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Shipping carrier (`'UPS'`, `'FedEx'`, `'USPS'`) |
| `tracking_number` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Carrier tracking number |
| `delivery_status` | `TEXT` | NO | `'UNFULFILLED'` | `CHECK (IN ('UNFULFILLED','SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RETURNED_TO_SENDER','LOST_IN_TRANSIT'))` | — | `INTERNAL` | Carrier milestone checkpoint |
| `shipped_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Carrier scan departure timestamp |
| `delivered_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Verified delivery timestamp |
| `delivery_signature_name` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Recipient delivery signer name |
| `item_summary` | `TEXT` | NO | — | — | — | `INTERNAL` | Purchased line items description |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Order placed timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Last update timestamp |

---

### 3. `disputes` (`ENT-03`)
Core dispute lifecycle tracking status, SLA deadlines, EV track & optimistic lock.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `PUBLIC` | Dispute identifier (`'DSP-GOLD-001'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Associated merchant identifier |
| `order_id` | `TEXT` | NO | — | `REFERENCES orders(id)` | `orders(id)` | `INTERNAL` | Disputed order identifier |
| `paypal_dispute_id` | `TEXT` | NO | — | `UNIQUE` | — | `PUBLIC` | PayPal Dispute ID (`'PP-D-881001'`) |
| `reason_code` | `TEXT` | NO | — | `CHECK (IN ('MERCHANDISE_OR_SERVICE_NOT_RECEIVED','SIGNIFICANTLY_NOT_AS_DESCRIBED','UNAUTHORISED','CANCELLED_RECURRING_BILLING','OTHER'))` | — | `PUBLIC` | Category of dispute (`BR-025`) |
| `status` | `TEXT` | NO | `'OPEN'` | `CHECK (IN ('OPEN','EVIDENCE_GATHERING','NEGOTIATING','READY_FOR_REVIEW','SUBMITTED','WON','LOST','SETTLED_VIA_REFUND','EXPIRED'))` | — | `PUBLIC` | State Machine Status (`BR-005`) |
| `dispute_amount_cents` | `INTEGER` | NO | — | `CHECK (dispute_amount_cents > 0 AND typeof(dispute_amount_cents) = 'integer')` | — | `INTERNAL` | Amount disputed in cents (`BR-001`) |
| `currency` | `TEXT` | NO | `'USD'` | — | — | `INTERNAL` | Dispute currency |
| `buyer_dispute_reason_text` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Customer dispute explanation |
| `seller_response_due_at` | `TEXT` | NO | — | `CHECK (> created_at)` | — | `INTERNAL` | PayPal response SLA deadline (`BR-002`) |
| `stage` | `TEXT` | NO | `'INQUIRY'` | `CHECK (IN ('INQUIRY','CHARGEBACK','PRE_ARBITRATION','ARBITRATION'))` | — | `PUBLIC` | PayPal dispute tier |
| `track` | `TEXT` | YES | `NULL` | `CHECK (IN ('TRACK_A_AUTO_SUBMIT','TRACK_B_NEGOTIATE','TRACK_C_AUTO_ACCEPT','TRACK_D_HUMAN_REVIEW'))` | — | `INTERNAL` | Step 18 Decision Table Route (`BR-016`) |
| `version` | `INTEGER` | NO | `1` | `CHECK (version >= 1)` | — | `INTERNAL` | Optimistic concurrency counter (`BR-015`) |
| `submitted_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Evidence submission timestamp |
| `resolved_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Terminal resolution timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Ingestion timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Last mutation timestamp |

---

### 4. `evidence_items` (`ENT-04`)
Multi-source gathered evidence items verified with SHA-256 digests (`BR-008`).

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Evidence item ID (`'evi_gold_001_1'`) |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Parent dispute ID |
| `order_id` | `TEXT` | NO | — | `REFERENCES orders(id)` | `orders(id)` | `INTERNAL` | Associated order ID |
| `evidence_type` | `TEXT` | NO | — | `CHECK (IN ('TRACKING_PROOF','DELIVERY_SIGNATURE','ORDER_RECEIPT','USAGE_LOG','CUSTOMER_COMMS','REFUND_POLICY','ITEM_DESCRIPTION','ACCESS_LOGS'))` | — | `INTERNAL` | Evidence classification |
| `source_system` | `TEXT` | NO | — | — | — | `INTERNAL` | Data source (`'SYSTEM_UPS'`, `'PAYPAL'`) |
| `title` | `TEXT` | NO | — | — | — | `INTERNAL` | Human-readable title |
| `content_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Canonical JSON data payload |
| `sha256_hash` | `TEXT` | NO | — | `CHECK (LENGTH(sha256_hash) = 64)` | — | `INTERNAL` | SHA-256 cryptographic digest (`BR-008`) |
| `is_verified` | `INTEGER` | NO | `1` | `CHECK (IN (0, 1))` | — | `INTERNAL` | Ground truth verification flag |
| `verified_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Verification timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Item creation timestamp |

---

### 5. `ai_assessments` (`ENT-05`)
Append-only audit history of AI Win Probability and Expected Value runs.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Assessment run ID |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Evaluated dispute |
| `win_probability` | `REAL` | NO | — | `CHECK (>= 0.0000 AND <= 1.0000)` | — | `INTERNAL` | Win Probability score $W$ (`BR-003`) |
| `expected_value_cents` | `INTEGER` | NO | — | `CHECK (typeof(expected_value_cents) = 'integer')` | — | `INTERNAL` | Expected Value of fighting in cents (`BR-007`) |
| `ev_settle_cents` | `INTEGER` | NO | — | `CHECK (typeof(ev_settle_cents) = 'integer')` | — | `INTERNAL` | Expected Value of settling in cents (`BR-007`) |
| `recommended_action` | `TEXT` | NO | — | `CHECK (IN ('AUTO_SUBMIT_EVIDENCE','OFFER_PARTIAL_REFUND','AUTO_ACCEPT_CLAIM','ESCALATE_TO_HUMAN'))` | — | `INTERNAL` | Recommended routing action |
| `confidence_score` | `REAL` | NO | — | `CHECK (>= 0.00 AND <= 1.00)` | — | `INTERNAL` | Model certainty metric |
| `reasoning_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Structured factors and weights |
| `model_version` | `TEXT` | NO | — | — | — | `INTERNAL` | Engine/model version (`'rule-ev-v1'`) |
| `prompt_tokens` | `INTEGER` | YES | `NULL` | — | — | `INTERNAL` | Prompt token count for cost tracking |
| `completion_tokens` | `INTEGER` | YES | `NULL` | — | — | `INTERNAL` | Completion token count |
| `execution_latency_ms` | `INTEGER` | NO | — | `CHECK (>= 0)` | — | `INTERNAL` | Evaluation latency in milliseconds |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Evaluation timestamp |

---

### 6. `negotiation_sessions` (`ENT-06`)
Buyer-facing autonomous AI settlement portal sessions.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Session ID (`'neg_gold_002'`) |
| `dispute_id` | `TEXT` | NO | — | `UNIQUE, REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | 1-to-1 link to dispute |
| `status` | `TEXT` | NO | `'ACTIVE'` | `CHECK (IN ('ACTIVE','COMPLETED_SETTLED','COMPLETED_REJECTED','EXPIRED','ESCALATED'))` | — | `INTERNAL` | Session lifecycle state |
| `token_hash` | `TEXT` | NO | — | `UNIQUE` | — | `RESTRICTED` | SHA-256 access token hash (`BR-019`) |
| `max_refund_allowed_cents` | `INTEGER` | NO | — | `CHECK (max_refund_allowed_cents >= 0 AND typeof(max_refund_allowed_cents) = 'integer')` | — | `INTERNAL` | Strict policy refund cap in cents (`BR-004`) |
| `messages_json` | `TEXT` | NO | `'[]'` | — | — | `CONFIDENTIAL/PII` | Array of chat turns with guardrail status |
| `guardrail_triggered_count` | `INTEGER` | NO | `0` | `CHECK (>= 0)` | — | `INTERNAL` | Count of prompt injection / cap blocks |
| `last_buyer_activity_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Buyer interaction timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Session initialization timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Session last activity timestamp |

---

### 7. `settlement_offers` (`ENT-07`)
Formal settlement offers (e.g. PayPal make-offer partial refunds) (`BR-004`).

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Offer ID (`'off_gold_003'`) |
| `dispute_id` | `TEXT` | NO | — | `REFERENCES disputes(id)` | `disputes(id)` | `INTERNAL` | Target dispute ID |
| `negotiation_session_id` | `TEXT` | NO | — | `REFERENCES negotiation_sessions(id)` | `negotiation_sessions(id)` | `INTERNAL` | Chat session reference |
| `offer_type` | `TEXT` | NO | `'PARTIAL_REFUND'` | `CHECK (IN ('PARTIAL_REFUND','REPLACEMENT','STORE_CREDIT'))` | — | `INTERNAL` | Offer modality |
| `offered_amount_cents` | `INTEGER` | NO | — | `CHECK (offered_amount_cents > 0 AND typeof(offered_amount_cents) = 'integer')` | — | `INTERNAL` | Proposed refund in cents (4200 = $42.00) |
| `max_allowed_cents` | `INTEGER` | NO | — | `CHECK (max_allowed_cents >= offered_amount_cents AND typeof(max_allowed_cents) = 'integer')` | — | `INTERNAL` | Policy ceiling at offer creation time |
| `status` | `TEXT` | NO | `'PROPOSED'` | `CHECK (IN ('PROPOSED','ACCEPTED','REJECTED','EXECUTED','CANCELLED'))` | — | `INTERNAL` | Offer state (`BR-018`) |
| `paypal_offer_id` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | PayPal API offer identifier |
| `proposed_by` | `TEXT` | NO | — | `CHECK (IN ('AGENT','BUYER','ANALYST'))` | — | `INTERNAL` | Actor who formulated offer |
| `buyer_response_text` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Remarks upon buyer response |
| `responded_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Response timestamp |
| `expires_at` | `TEXT` | YES | `NULL` | `CHECK (> created_at)` | — | `INTERNAL` | Offer expiration timestamp (`BR-018`) |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Mutation timestamp |

---

### 8. `policy_rules` (`ENT-08`)
Merchant policy configuration governing automated thresholds & refund caps.

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Policy configuration ID (`'pol_default'`) |
| `merchant_id` | `TEXT` | NO | — | `REFERENCES merchants(id)` | `merchants(id)` | `INTERNAL` | Merchant account |
| `max_auto_dispute_cents` | `INTEGER` | NO | `25000` | `CHECK (max_auto_dispute_cents >= 0 AND typeof(max_auto_dispute_cents) = 'integer')` | — | `INTERNAL` | Human approval gate threshold ($250.00) (`BR-006`) |
| `max_refund_offer_pct` | `REAL` | NO | `0.40` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Maximum partial refund cap fraction (0.40 = 40%) (`BR-004`) |
| `min_win_prob_auto_submit` | `REAL` | NO | `0.75` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Track A auto-submit threshold (0.75) |
| `auto_accept_below_cents` | `INTEGER` | NO | `3500` | `CHECK (auto_accept_below_cents >= 0 AND typeof(auto_accept_below_cents) = 'integer')` | — | `INTERNAL` | Track C auto-accept ceiling ($35.00) (`BR-017`) |
| `min_win_prob_auto_accept` | `REAL` | NO | `0.35` | `CHECK (>= 0.0 AND <= 1.0)` | — | `INTERNAL` | Low win-rate bar for auto-accept |
| `default_ops_cost_cents` | `INTEGER` | NO | `500` | `CHECK (default_ops_cost_cents >= 0 AND typeof(default_ops_cost_cents) = 'integer')` | — | `INTERNAL` | Operational review cost ($5.00) (`BR-007`) |
| `sla_buffer_hours` | `INTEGER` | NO | `4` | `CHECK (>= 1)` | — | `INTERNAL` | Emergency fallback window in hours (`BR-010`) |
| `is_active` | `INTEGER` | NO | `1` | `CHECK (IN (0, 1))` | — | `INTERNAL` | Active configuration flag |
| `version` | `INTEGER` | NO | `1` | `CHECK (version >= 1)` | — | `INTERNAL` | Policy version counter |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Creation timestamp |
| `updated_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Modification timestamp |

---

### 9. `audit_logs` (`ENT-09`)
Append-only tamper-evident audit ledger for all mutations & tool calls (`BR-012`).

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Audit entry UUID |
| `merchant_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Associated merchant identifier |
| `entity_type` | `TEXT` | NO | — | — | — | `INTERNAL` | Mutated table name (`'disputes'`, `'settlement_offers'`) |
| `entity_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Primary key of mutated record |
| `action` | `TEXT` | NO | — | — | — | `INTERNAL` | Action executed (`'STATE_TRANSITION'`, `'MCP_CALL'`) |
| `actor_id` | `TEXT` | NO | — | — | — | `INTERNAL` | Identifier of actor (`'ACT-01'`, `'ACT-04'`) |
| `actor_type` | `TEXT` | NO | — | `CHECK (IN ('SYSTEM','AI_AGENT','MERCHANT_USER','BUYER','EXTERNAL_WEBHOOK'))` | — | `INTERNAL` | Actor category |
| `previous_state_json` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Snapshot before mutation |
| `new_state_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Snapshot after mutation |
| `rule_ids_checked` | `TEXT` | NO | — | — | — | `INTERNAL` | JSON array of rules verified (e.g. `["BR-004","BR-006"]`) |
| `guardrail_status` | `TEXT` | NO | — | `CHECK (IN ('PASSED','BLOCKED','WARNING'))` | — | `INTERNAL` | Guardrail verdict |
| `ip_address` | `TEXT` | YES | `NULL` | — | — | `CONFIDENTIAL/PII` | Masked client IP address |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Immutable timestamp (`BR-012`) |

---

### 10. `webhook_events` (`ENT-10`)
Raw PayPal webhook ledger for deduplication, payload retention, and replay (`BR-011`).

| Column Name | Type | Nullable | Default | Constraints / Checks | FK Reference | PII Tag | Business Meaning & Example |
| :--- | :--- | :---: | :--- | :--- | :--- | :---: | :--- |
| `id` | `TEXT` | NO | — | `PRIMARY KEY NOT NULL` | — | `INTERNAL` | Ingestion record UUID |
| `webhook_id` | `TEXT` | NO | — | `UNIQUE` | — | `PUBLIC` | PayPal Transmission ID (`WH-XXXXX`) (`BR-011`) |
| `event_type` | `TEXT` | NO | — | — | — | `PUBLIC` | Event type (`'CUSTOMER.DISPUTE.CREATED'`) |
| `resource_id` | `TEXT` | NO | — | — | — | `PUBLIC` | Target PayPal Dispute ID |
| `payload_json` | `TEXT` | NO | — | — | — | `INTERNAL` | Verbatim webhook payload |
| `processing_status` | `TEXT` | NO | `'PENDING'` | `CHECK (IN ('PENDING','PROCESSED','DUPLICATE_IGNORED','QUARANTINED','FAILED'))` | — | `INTERNAL` | Ingestion status (`BR-011`, `BR-023`) |
| `quarantine_reason` | `TEXT` | YES | `NULL` | — | — | `INTERNAL` | Quarantine diagnosis (`EXC-01`) |
| `retry_count` | `INTEGER` | NO | `0` | `CHECK (>= 0)` | — | `INTERNAL` | Delivery retry attempt counter |
| `processed_at` | `TEXT` | YES | `NULL` | ISO-8601 UTC | — | `INTERNAL` | Processing completion timestamp |
| `created_at` | `TEXT` | NO | `CURRENT_TIMESTAMP` | ISO-8601 UTC | — | `INTERNAL` | Receipt timestamp |

---

## 3. SQLite Triggers & Ledger Protections

1. **`trg_disputes_check_order_amount_insert` & `update` (`BR-001`):**  
   Ensures `NEW.dispute_amount_cents <= (SELECT amount_cents FROM orders WHERE id = NEW.order_id)`. Rejects insertion or update exceeding the original captured transaction amount.
2. **`trg_orders_check_dispute_amount_update` (`BR-001`):**  
   Ensures `NEW.amount_cents >= (SELECT COALESCE(MAX(dispute_amount_cents), 0) FROM disputes WHERE order_id = OLD.id)`. Rejects lowering an order's captured amount below any active or recorded dispute amount.
3. **`trg_disputes_immutable_terminal_states` (`BR-005`):**  
   Strictly enforces that any dispute in a terminal state (`'WON'`, `'LOST'`, `'SETTLED_VIA_REFUND'`, `'EXPIRED'`) is 100% immutable: any attempt to modify status or any other column throws an abort signal.
4. **`trg_audit_logs_no_update` & `no_delete` (`BR-012`):**  
   Strictly enforces append-only immutability for `audit_logs`. Any attempt to update or delete rows throws an abort signal.

---

## 4. Performance Index Inventory (20 Composite Indexes)

| # | Index Name | Table | Indexed Columns | Justification / Query Path |
|---|---|---|---|---|
| 1 | `idx_merchants_mode` | `merchants` | `(paypal_mode)` | Quick lookup of simulation vs sandbox mode |
| 2 | `idx_orders_merchant_id` | `orders` | `(merchant_id)` | Scoping orders to tenant |
| 3 | `idx_orders_paypal_id` | `orders` | `(paypal_order_id)` | Fast lookup by PayPal Order ID |
| 4 | `idx_orders_tracking` | `orders` | `(carrier_name, tracking_number)` | Carrier tracking reconciliation |
| 5 | `idx_orders_delivery_status` | `orders` | `(delivery_status)` | Carrier checkpoint filtering |
| 6 | `idx_disputes_merchant_status_due`| `disputes` | `(merchant_id, status, seller_response_due_at)` | SLA countdown workbench queue |
| 7 | `idx_disputes_status_merchant` | `disputes` | `(status, merchant_id)` | C-Suite KPI aggregate metrics |
| 8 | `idx_disputes_order_id` | `disputes` | `(order_id)` | Order-to-dispute join |
| 9 | `idx_disputes_paypal_id` | `disputes` | `(paypal_dispute_id)` | Webhook dispute lookup |
| 10 | `idx_disputes_track` | `disputes` | `(track)` | Routing track filtering |
| 11 | `idx_evidence_dispute_type` | `evidence_items` | `(dispute_id, evidence_type)` | Evidence bundle compilation |
| 12 | `idx_evidence_sha256` | `evidence_items` | `(sha256_hash)` | SHA-256 duplicate & tampering verification |
| 13 | `idx_assessments_dispute_created` | `ai_assessments` | `(dispute_id, created_at DESC)` | Latest AI assessment lookup |
| 14 | `idx_negotiation_dispute` | `negotiation_sessions` | `(dispute_id)` | Chat session binding |
| 15 | `idx_negotiation_token` | `negotiation_sessions` | `(token_hash)` | Public buyer authentication token lookup |
| 16 | `idx_settlement_dispute_status` | `settlement_offers` | `(dispute_id, status)` | Active settlement offer lookup |
| 17 | `idx_settlement_session` | `settlement_offers` | `(negotiation_session_id)` | Chat thread offer binding |
| 18 | `idx_audit_entity_action` | `audit_logs` | `(entity_type, entity_id, action)` | Forensic history lookups |
| 19 | `idx_audit_merchant_created` | `audit_logs` | `(merchant_id, created_at DESC)` | Audit stream feed |
| 20 | `idx_audit_actor_type` | `audit_logs` | `(actor_type)` | KPI-005 autonomous vs human ratio |
| 21 | `idx_webhooks_webhook_id` | `webhook_events` | `(webhook_id)` | Webhook deduplication lookup (`BR-011`) |
| 22 | `idx_webhooks_resource_status` | `webhook_events` | `(resource_id, processing_status)` | Replay and status tracking |
| 23 | `idx_policy_rules_merchant_active` | `policy_rules` | `(merchant_id, is_active)` | Active policy lookup |
