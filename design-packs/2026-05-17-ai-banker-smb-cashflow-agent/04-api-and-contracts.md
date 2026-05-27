# 04 - API and Contracts

> Surface area for the AI Banker for SMB owners. External SMB-facing HTTP+SSE/WebSocket
> API, third-party webhooks, outbound tool contracts that the LangGraph agents call,
> the agent↔orchestrator gRPC, the error model, and the idempotency/streaming rules.
>
> Anchors:
> - DAG checkpointing + retry semantics for resumable agent runs - `resume.txt` L52–54;
>   `blackbox-experience.md` #12–15.
> - Tool-calling infrastructure for ReAct agents - `resume.txt` L51; `blackbox-experience.md` #9.
> - Model router pattern across Claude/GPT/Grok at 1B+ tokens/month - `resume.txt` L55–56;
>   `blackbox-experience.md` #16–19.
> - Deterministic replay over telemetry mesh (50M spans/day) - `resume.txt` L58–59;
>   `blackbox-experience.md` #20.

---

## 1. External (SMB-facing) HTTP+WebSocket API

### 1.1 Conventions

| Concern | Rule |
| --- | --- |
| Base URL | `https://api.aibanker.in/v1` |
| Auth | OAuth2 bearer (`Authorization: Bearer …`). Scopes: `banker.read`, `banker.act`, `banker.admin`. mTLS for partner-issued tokens. |
| Tenant | `X-Tenant-Id: tnt_<ulid>` required on every call. `X-Business-Id: biz_<ulid>` required for any business-scoped read or write. |
| Idempotency | All `POST`/`PATCH`/`DELETE` accept `Idempotency-Key: <ULID>` (24h Redis window, then archived to Postgres `actions` table). |
| Rate limit | Default 60 req/min/tenant, burst 120; `banker.act` writes 10 req/min/business; conversation creation 12/min/user. Headers `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |
| Tracing | Server injects `traceparent` (W3C) into the LLMOps mesh - every span lands in ClickHouse for replay (`resume.txt` L58–59). |
| Versioning | URL-pinned (`/v1`). Schema deprecation announced via `Sunset` header 90 days before removal. |
| Content | `application/json; charset=utf-8`. Streaming surfaces use `text/event-stream` (SSE). |

### 1.2 Endpoint surface

| Method | Path | Auth scope | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/conversations` | `banker.read` | Create a run (idempotent). Returns `run_id`. |
| `POST` | `/v1/conversations/{run_id}/messages` | `banker.read` | Append user message. Idempotency required. |
| `GET`  | `/v1/conversations/{run_id}/messages?after=<seq>` | `banker.read` | Polled fetch. Upgrade with `Accept: text/event-stream` for SSE. |
| `GET`  | `/v1/runs/{run_id}` | `banker.read` | Status: `queued \| running \| awaiting_human \| completed \| failed \| cancelled`. |
| `POST` | `/v1/runs/{run_id}/approve` | `banker.act` | HITL approval payload. Carries signed `decision_token`. |
| `POST` | `/v1/runs/{run_id}/cancel` | `banker.read` | Cooperative abort. |
| `GET`  | `/v1/cashflow/forecast?horizon_days=30&scenario=base` | `banker.read` | Deterministic forecast endpoint. Cacheable (`Cache-Control: max-age=300`). |
| `GET`  | `/v1/invoices?status=overdue&type=AR&page_size=50` | `banker.read` | Typed query endpoint. ETag supported. |
| `POST` | `/v1/actions/payments` | `banker.act` | Initiate payment. Always requires HITL unless under standing-instruction policy. |
| `GET`  | `/v1/audit/{run_id}` | `banker.admin` | Full audit trail (transcript + tool calls + state checkpoints). |

### 1.3 Detailed endpoint specs

#### 1.3.1 `POST /v1/conversations` - create a run

Headers
```
Authorization: Bearer <jwt>
X-Tenant-Id: tnt_01HXYZ…
X-Business-Id: biz_01HXYZ…
Idempotency-Key: 01HXYZ7N3Q8K…
Content-Type: application/json
```

Request
```json
{
  "channel": "mobile",
  "locale": "en-IN",
  "initial_message": "Will I have enough cash for payroll on the 28th?",
  "context_hints": { "include_kb": true, "horizon_days": 14 },
  "policy_overrides": null
}
```

Response - `201 Created`
```json
{
  "run_id": "run_01HXYZ8N3Q8KQH7B5Z1F2KX7VC",
  "status": "queued",
  "graph_version": "v4.2.1",
  "created_at": "2026-05-17T07:14:22.318Z",
  "sse_url": "/v1/conversations/run_01HX…/messages?stream=1",
  "budget": { "max_hops": 16, "max_tokens": 60000, "max_wall_ms": 60000 }
}
```

Errors → see §5. Notable: `TENANT_SUSPENDED` (403), `BUDGET_TENANT_EXHAUSTED` (429), `GUARDRAIL_BLOCK_INPUT` (422).

Rate limit: 12/min/user, 60/min/business. Idempotency: replays within 24h return original `run_id` + `201`.

---

#### 1.3.2 `POST /v1/conversations/{run_id}/messages` - append a message

Request
```json
{
  "sequence": 2,
  "role": "user",
  "content": "Also delay the AWS payment if we’re tight.",
  "attachments": []
}
```

Response - `202 Accepted`
```json
{
  "message_id": "msg_01HX…",
  "sequence": 2,
  "accepted_at": "2026-05-17T07:14:31.002Z",
  "run_status": "running"
}
```

Idempotency: `(run_id, Idempotency-Key)` dedupe; replays return original `message_id`. Out-of-order `sequence` → `409 SEQUENCE_CONFLICT` with `expected_sequence` field.

---

#### 1.3.3 `POST /v1/actions/payments` - initiate a payment

Headers add `Idempotency-Key` (mandatory; rejected otherwise). Optional `X-Step-Up-Token` carrying an OTP-bound token if business policy demands.

Request
```json
{
  "run_id": "run_01HX…",
  "business_id": "biz_01HX…",
  "debtor_account_id": "acc_hdfc_01HX…",
  "creditor": {
    "name": "AWS Internet Services Pvt Ltd",
    "upi_vpa": "awsindia@hdfcbank",
    "ifsc": null,
    "account_number": null,
    "gstin": "29AAACA8772A1ZL"
  },
  "amount": { "value": 245300, "currency": "INR" },
  "purpose_code": "P1306",
  "reason": "Cloud infra - Apr invoice INV-2026-04-08812",
  "schedule": "immediate",
  "requires_otp": true,
  "policy_acknowledgements": ["spending_cap_acknowledged"]
}
```

Response - `202 Accepted` (payment is queued, never auto-completed)
```json
{
  "action_id": "act_01HX…",
  "status": "awaiting_approval",
  "approval_url": "https://app.aibanker.in/approve/act_01HX…",
  "expires_at": "2026-05-17T07:29:31Z",
  "policy_findings": [
    { "rule": "vendor.new_payee_cooloff", "severity": "warn", "message": "First payment to this VPA in 90 days. 4-eye approval required." }
  ],
  "estimated_balance_after": { "value": 1487000, "currency": "INR" }
}
```

Errors: `POLICY_DENY` (403), `INSUFFICIENT_FUNDS_FORECAST` (409), `DUP_IDEMPOTENT_DIFFERENT_BODY` (409), `UPSTREAM_BANK_DEGRADED` (503).

Idempotency: hard requirement. Same `Idempotency-Key` + same body → original `action_id`. Same key + different body → `409 DUP_IDEMPOTENT_DIFFERENT_BODY` (saves the SMB from double-debit during retry storms).

Rate limit: 10/min/business, 2 concurrent in-flight payments per business.

---

#### 1.3.4 `GET /v1/cashflow/forecast?horizon_days=30`

Query params: `horizon_days` (1..180), `scenario` (`base`|`stress`|`vendor_delay`), `as_of` (RFC3339, defaults to now). ETag-aware.

Response - `200 OK`
```json
{
  "business_id": "biz_01HX…",
  "currency": "INR",
  "as_of": "2026-05-17T07:00:00Z",
  "horizon_days": 30,
  "method": "deterministic_waterfall+mc_ar",
  "model_version": "fc-2026-05-01",
  "opening_balance": 2840000,
  "series": [
    { "date": "2026-05-18", "p10": 2715000, "p50": 2810000, "p90": 2895000, "known_inflows": 0,    "known_outflows": 30000 },
    { "date": "2026-05-28", "p10":  640000, "p50":  920000, "p90": 1240000, "known_inflows": 350000, "known_outflows": 1450000 }
  ],
  "key_events": [
    { "date": "2026-05-28", "kind": "payroll",       "amount": 1100000, "confidence": "scheduled" },
    { "date": "2026-05-20", "kind": "gst_3b",        "amount":  185000, "confidence": "scheduled" },
    { "date": "2026-05-22", "kind": "ar_collection", "amount":  350000, "confidence": "p50_estimate" }
  ],
  "explanation_run_id": null
}
```

`explanation_run_id` is `null` for the bare endpoint - the explainer LLM is only invoked when the SMB asks a question via the conversation API. This keeps the forecast deterministic and cacheable; the LLM is an explainer over numbers, not a projector (`resume.txt` L52–54).

---

## 2. Webhook contracts (third-party → us)

All inbound webhooks share a common envelope and verification scheme.

### 2.1 Common envelope and verification

Headers (every inbound webhook)
```
X-Webhook-Source: plaid | aa-onemoney | razorpay | razorpayx | tally | zoho | quickbooks | gusto
X-Webhook-Id: evt_<source>_<ulid>
X-Webhook-Timestamp: 1747465162
X-Webhook-Signature: sha256=<hex hmac>
Content-Type: application/json
```

Verification rules:
1. `|now - X-Webhook-Timestamp| <= 300s` else `401 STALE_TIMESTAMP`.
2. HMAC-SHA256 of `f"{timestamp}.{raw_body}"` with the per-source rotated secret; constant-time compare.
3. `(source, X-Webhook-Id)` deduped in Redis 7d, then in Postgres `inbound_events` table (PK constraint). Duplicate → `200 OK` no-op.
4. Nonce window: timestamp + event_id pair is the replay key; any reuse within window → silent drop with audit row.
5. `202 Accepted` once persisted to the inbound queue (Kafka topic `webhooks.raw`). Processing is async; we never block partners on downstream work.

### 2.2 Bank webhook (Plaid / Account Aggregator / Razorpay)

```json
{
  "event_type": "transaction.posted",
  "occurred_at": "2026-05-17T07:12:33Z",
  "account": { "external_id": "ACC-HDFC-***4421", "kind": "current" },
  "txn": {
    "external_id": "TXN-2026051712334421",
    "amount": -245300,
    "currency": "INR",
    "counterparty": "AWS INTERNET SERVICES",
    "method": "neft",
    "reference": "INV-2026-04-08812",
    "posted_at": "2026-05-17T07:12:00Z"
  }
}
```

### 2.3 Accounting webhook (Tally / Zoho / QuickBooks)

```json
{
  "event_type": "invoice.updated",
  "occurred_at": "2026-05-17T06:55:00Z",
  "invoice": {
    "external_id": "INV-2026-04-00231",
    "type": "AR",
    "counterparty": { "name": "Zentra Logistics", "gstin": "27ABCDE1234F1Z5" },
    "issued_at": "2026-04-12",
    "due_at":    "2026-05-12",
    "amount":    480000,
    "currency":  "INR",
    "status":    "overdue",
    "line_items_hash": "sha256:8f1c…"
  }
}
```

### 2.4 Payroll webhook (RazorpayX / Gusto)

```json
{
  "event_type": "payrun.scheduled",
  "payrun": {
    "external_id": "PR-2026-05",
    "scheduled_for": "2026-05-28",
    "total_amount": 1100000,
    "currency": "INR",
    "headcount": 27,
    "confirmation_required_by": "2026-05-27T18:00:00+05:30"
  }
}
```

Replay protection summary: HMAC + 5-min timestamp window + idempotent event-id dedupe (Redis 7d, then Postgres unique constraint). All raw bodies persisted to S3 with object lock for SOC-2 evidence (`blackbox-experience.md` #5).

---

## 3. Outbound tool contracts (us → third-party / internal)

All tool calls go through the Tool Gateway. Schemas are JSON Schema draft-2020-12 (gRPC mirror for high-QPS internal tools). Tools are versioned (`bank.get_balance@v1`); the registry tags each one with capability, idempotency, retry, timeout, and the **allowed caller nodes** (only the listed LangGraph nodes may invoke the tool - enforced at the gateway, not the agent prompt). This is the same pattern that backed the ReAct tool-calling layer at BlackBox (`resume.txt` L51, `blackbox-experience.md` #9).

| # | Tool | Capability | Idempotency | Retry | Timeout | Allowed caller nodes |
| - | --- | --- | --- | --- | --- | --- |
| 1 | `bank.get_balance(account_id)` | READ | n/a (GET) | 3× exp backoff 200ms..2s | 2s | Supervisor, CashflowForecaster, PayrollReadiness, AP, APAgent |
| 2 | `bank.list_transactions(account_id, since, until, cursor?)` | READ | cursor-stable | 3× | 5s | CashflowForecaster, AnomalyExplainer |
| 3 | `bank.initiate_payment(idempotency_key, debtor, creditor, amount, currency, reason, requires_otp)` | WRITE_IRREVERSIBLE | mandatory key | **no auto-retry on timeout** → reconcile via `bank.get_payment_status` | 8s | ActionExecutor only |
| 4 | `accounting.list_invoices(status, since, type)` | READ | n/a | 3× | 4s | AR, AP, CashflowForecaster |
| 5 | `accounting.get_aging_report()` | READ | n/a | 3× | 4s | AR, AP, WorkingCapitalAdvisor |
| 6 | `accounting.send_invoice_reminder(invoice_id, channel, template_id, idempotency_key)` | WRITE_REVERSIBLE | mandatory key | 3× | 4s | ActionExecutor (initiated by AR) |
| 7 | `payroll.get_next_pay_run()` | READ | n/a | 3× | 3s | PayrollReadiness, CashflowForecaster |
| 8 | `payroll.compute_required_balance(payrun_id)` | READ | n/a | 2× | 2s | PayrollReadiness |
| 9 | `tax.get_upcoming_obligations()` | READ | n/a | 3× | 3s | TaxGST, CashflowForecaster |
| 10 | `tax.file_gstr(gstr_type, payload, idempotency_key)` **[HITL]** | WRITE_IRREVERSIBLE | mandatory key + signed HITL token | no auto-retry | 12s | ActionExecutor only, post-approval |
| 11 | `lender.get_credit_line_offers(business_profile)` | READ | n/a | 3× | 6s | WorkingCapitalAdvisor |
| 12 | `lender.accept_offer(offer_id, signed_consent, idempotency_key)` **[HITL]** | WRITE_IRREVERSIBLE | mandatory key + consent artifact | no auto-retry | 10s | ActionExecutor only, post-approval |
| 13 | `notify.send_to_user(channel, template, params)` | WRITE_REVERSIBLE | dedupe on `(business_id, template, params_hash, day)` | 5× | 3s | ExplainerLLM, AR, AP, PayrollReadiness |
| 14 | `forecast.project_cashflow(horizon_days, scenario)` *(internal deterministic)* | READ | content-hash cache 5min | 1× | 600ms | CashflowForecaster, PayrollReadiness, WorkingCapitalAdvisor |
| 15 | `kb.search_business_context(query, top_k, filters)` *(internal RAG)* | READ | n/a | 2× | 400ms | Supervisor, all specialists |

Notes:

- **WRITE_IRREVERSIBLE** tools are the only ones routed through the `ActionExecutor` node and require a HITL decision token (or a pre-approved standing-instruction policy match). Same separation-of-duties pattern used for sandbox-side WASM execution at BlackBox (`blackbox-experience.md` #4, #19).
- **Retry policy**: never auto-retry irreversible writes on ambiguous failure (timeout, 5xx without idempotency confirmation). Instead schedule a reconciliation pull from a status endpoint inside the same saga step.
- **Gateway-enforced caller scope**: the tool registry pins `allowed_caller_nodes`; an agent node attempting an out-of-scope call gets `TOOL_FORBIDDEN_CALLER` (and the run is flagged for review). The agent's prompt cannot widen its toolset at runtime.

Example tool schema - `bank.initiate_payment@v1`:
```json
{
  "$id": "tools/bank.initiate_payment@v1",
  "type": "object",
  "required": ["idempotency_key","debtor_account_id","creditor","amount","currency","reason","requires_otp"],
  "properties": {
    "idempotency_key": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "debtor_account_id": { "type": "string" },
    "creditor": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "minLength": 2 },
        "upi_vpa": { "type": "string", "pattern": "^[\\w.\\-]{2,256}@[\\w.\\-]{2,64}$" },
        "ifsc": { "type": ["string","null"], "pattern": "^[A-Z]{4}0[A-Z0-9]{6}$" },
        "account_number": { "type": ["string","null"], "minLength": 6 },
        "gstin": { "type": ["string","null"], "pattern": "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][A-Z][0-9A-Z]$" }
      },
      "oneOf": [ { "required": ["upi_vpa"] }, { "required": ["ifsc","account_number"] } ]
    },
    "amount":   { "type": "integer", "minimum": 100, "maximum": 50000000 },
    "currency": { "const": "INR" },
    "reason":   { "type": "string", "maxLength": 240 },
    "requires_otp": { "type": "boolean" }
  }
}
```

---

## 4. Agent ↔ orchestrator contract (internal gRPC)

The Orchestrator is the only client of the Agent Runtime; the API Gateway never talks to agents directly. gRPC over mTLS with deadline propagation and W3C `traceparent` injected.

```proto
service AgentRuntime {
  rpc StartRun       (StartRunRequest)        returns (StartRunResponse);
  rpc SubmitMessage  (SubmitMessageRequest)   returns (SubmitMessageResponse);
  rpc StreamEvents   (StreamEventsRequest)    returns (stream RunEvent);
  rpc Checkpoint     (CheckpointRequest)      returns (CheckpointResponse);
  rpc Resume         (ResumeRequest)          returns (ResumeResponse);
  rpc Abort          (AbortRequest)           returns (AbortResponse);
}

message RunState {
  string  run_id        = 1;
  string  tenant_id     = 2;
  string  business_id   = 3;
  uint64  version       = 4;     // monotonic per run; optimistic concurrency
  uint32  hop_count     = 5;
  Context context       = 6;
  repeated Turn transcript            = 7;
  repeated ToolCall pending_tool_calls = 8;
  Scratchpad scratchpad = 9;
  Budget    budget_used = 10;    // tokens, wall_ms, $ cents
  string    graph_version = 11;
}
```

Behavior:

- `Checkpoint` writes the new `RunState` as an append-only row in `run_state` (Postgres) keyed by `(run_id, version)`. The latest row wins on `max(version)`. Same DAG checkpointing semantics used in the BlackBox workflow engine (`resume.txt` L52–54; `blackbox-experience.md` #12–15).
- `Resume` claims the run with `SELECT … FOR UPDATE SKIP LOCKED` and rehydrates state at the latest version.
- `StreamEvents` is the canonical event stream used by both the SSE bridge and the Langfuse-style replay UI; events are also dual-written into the ClickHouse trace store.

---

## 5. Error model

Common envelope on every 4xx/5xx:
```json
{
  "error": {
    "code": "POLICY_DENY",
    "http_status": 403,
    "message": "Vendor 'AWS Internet Services' exceeds new-payee cool-off policy.",
    "user_message": "We need a manager to approve a first-time payment to this vendor.",
    "retry": "not_retryable",
    "trace_id": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "details": { "rule": "vendor.new_payee_cooloff", "cool_off_days_remaining": 12 }
  }
}
```

| Code | HTTP | Meaning | Retry advice | User-visible |
| --- | --- | --- | --- | --- |
| `AUTH_MISSING` | 401 | No/invalid bearer | not retryable | "Please sign in again." |
| `AUTH_SCOPE_INSUFFICIENT` | 403 | Token missing scope (`banker.act`) | not retryable | "You don't have permission for this action." |
| `AUTH_STEPUP_REQUIRED` | 401 | OTP/biometric needed | retry after step-up | "We need to verify it's you." |
| `RATE_LIMIT_TENANT` | 429 | Tenant budget exhausted | retry after `Retry-After` | "Too many requests. Try again shortly." |
| `RATE_LIMIT_USER` | 429 | Per-user QPS | retry after `Retry-After` | "Too many requests. Try again shortly." |
| `TENANT_SUSPENDED` | 403 | Billing/compliance hold | not retryable | "Account access paused - contact support." |
| `TENANT_NOT_FOUND` | 404 | Unknown tenant/business | not retryable | "Workspace not found." |
| `TOOL_FORBIDDEN_CALLER` | 403 | Agent node not allowed to call tool | not retryable; run flagged | hidden |
| `TOOL_TIMEOUT` | 504 | Upstream tool timeout | reconcile via status pull | "Bank is slow right now. We're checking." |
| `TOOL_VALIDATION` | 400 | Bad payload to tool | not retryable | hidden |
| `BUDGET_EXCEEDED_TOKENS` | 429 | Run token budget exhausted | not retryable for run | "Question got too complex - try narrower." |
| `BUDGET_EXCEEDED_HOPS` | 429 | Max hop count hit | not retryable for run | as above |
| `BUDGET_TENANT_EXHAUSTED` | 429 | Monthly $ cap hit | not retryable | "Plan limit reached." |
| `GUARDRAIL_BLOCK_INPUT` | 422 | Prompt-injection or PII leak detected | not retryable | "We can't process that message safely." |
| `GUARDRAIL_BLOCK_OUTPUT` | 422 | Generated answer failed grounding/PII check | regenerate once | "Let me rephrase that." |
| `POLICY_DENY` | 403 | Action denied by policy engine | not retryable without override | rule-specific |
| `INSUFFICIENT_FUNDS_FORECAST` | 409 | Forecast says payment will overdraw payroll | not retryable | "This would leave you short for payroll on the 28th." |
| `DUP_IDEMPOTENT_DIFFERENT_BODY` | 409 | Same key, different body | not retryable | hidden - protects from double-debit |
| `SEQUENCE_CONFLICT` | 409 | Out-of-order message | retry with `expected_sequence` | hidden |
| `UPSTREAM_BANK_DEGRADED` | 503 | Bank API circuit open | retry after `Retry-After` | "Bank connection is degraded." |
| `UPSTREAM_LLM_DEGRADED` | 503 | All routed models unhealthy | fallback queued | "Thinking is slow right now." |
| `INTERNAL_CHECKPOINT_LOST` | 500 | Run state version mismatch | resume from prior checkpoint | hidden |
| `INTERNAL_UNKNOWN` | 500 | Unhandled | reported to on-call | "Something went wrong." |

---

## 6. Idempotency model

Three layers, each owning a different concern:

1. **API Gateway (Redis 24h, then Postgres `idempotency_keys`)**
   - Key: `(tenant_id, idempotency_key, route)` → `{ request_hash, response, http_status }`.
   - Same key + same `request_hash` → replay original response.
   - Same key + different hash → `409 DUP_IDEMPOTENT_DIFFERENT_BODY`.
   - 24h hot window in Redis (per-region), then archived to Postgres for the 7-day window required by partner banks; the `actions` table keeps the cold record for SOC-2 audit.

2. **Action Executor (Postgres `actions` table)**
   - Persists `(tenant_id, idempotency_key) → action_id` so saga compensation can locate prior attempts even after Redis eviction.
   - State machine in §05.4 ensures the same action_id cannot transition `INITIATED` twice.

3. **Tool Gateway (deterministic per-tool suffix)**
   - The agent supplies its run-scoped idempotency key; the gateway derives the per-tool key as `sha256(run_key | node_id | tool_name | arg_hash)[:26]`.
   - Guarantees: same `(run, node, tool, args)` always produces the same upstream idempotency key, so retries across worker restarts collapse to one upstream side effect. Matches the durable-execution guarantee from the BlackBox workflow engine (`blackbox-experience.md` #15, #17).

---

## 7. Streaming and back-pressure

Conversation events are delivered over SSE (and WebSocket for mobile clients that need duplex). Event taxonomy:

```
event: thought         # LLM reasoning chunks; lossy
event: tool_call       # tool name + args (redacted PII); lossless
event: tool_result     # tool response summary; lossless
event: partial_answer  # streamed natural-language tokens; lossy on overload
event: final_answer    # terminal; lossless, ack required
event: error           # terminal or recoverable; lossless
event: heartbeat       # every 15s
```

Example wire frame:
```
id: 17
event: tool_call
data: {"node":"PayrollReadinessAgent","tool":"payroll.compute_required_balance","args":{"payrun_id":"PR-2026-05"}}

id: 18
event: tool_result
data: {"node":"PayrollReadinessAgent","tool":"payroll.compute_required_balance","summary":{"required":1187500,"currency":"INR"}}

id: 19
event: partial_answer
data: "You'll have roughly ₹9.2L by payroll day, but payroll plus GST needs ~₹12.8L. "
```

Back-pressure rules:
- Buffer per connection: 256 events. On overflow, drop `thought` and `partial_answer` (lossy classes), never `tool_call`/`tool_result`/`final_answer`/`error`.
- Clients send `Last-Event-Id` to resume after disconnect; the SSE bridge re-reads from the ClickHouse event store for the missing range. Same replay design used in the BlackBox telemetry mesh (`resume.txt` L58–59).
- Heartbeats every 15s; mobile WebSocket close after 60s without server frame.

---
