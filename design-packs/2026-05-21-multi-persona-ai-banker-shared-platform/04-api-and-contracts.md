# 04 — API and Contracts: Multi-Persona AI Banker (Shared Platform)

> Scope: External REST/SSE surface for clients (mobile, web, SME dashboard, CFO console, partner API) and internal gRPC + Kafka contracts between platform services. Persona-aware (Retail / SME / CFO), multi-tenant, auditable.
>
> Companion files: `03-architecture.md` (system map), `05-low-level-design.md` (internal design), `12-agentic-graph-structure.md` (LangGraph topology), `13-memory-layer-design.md` (memory tier schemas), `15-guardrails.md` (policy + tool guardrails).

---

## 1. API surface summary

| Resource | Operation | Method | Path | Persona scope |
|----------|-----------|--------|------|---------------|
| Sessions | Create | POST | `/v1/sessions` | retail, sme, cfo |
| Sessions | Get | GET | `/v1/sessions/{id}` | owner |
| Messages | Send (sync) | POST | `/v1/sessions/{id}/messages` | owner |
| Messages | Stream (SSE) | POST | `/v1/sessions/{id}/messages:stream` | owner |
| Messages | History | GET | `/v1/sessions/{id}/messages` | owner |
| Insights | List proactive | GET | `/v1/insights/proactive` | owner |
| Insights | Dismiss | POST | `/v1/insights/proactive/{id}/dismiss` | owner |
| Actions | Propose | POST | `/v1/actions` | owner |
| Actions | Approve / Reject | POST | `/v1/actions/{id}/approve` | reviewer |
| Actions | Get state | GET | `/v1/actions/{id}` | owner, reviewer |
| Feedback | Submit | POST | `/v1/feedback` | owner |
| Audit | Query | GET | `/v1/audit` | auditor-only |
| Health | Liveness | GET | `/v1/healthz` | public |

All paths are mounted under the tenant-scoped base `https://api.bank-ai.example.com/{tenant_slug}/v1/...`. The tenant is also asserted in the JWT claim `tnt`; if the URL slug and JWT tenant disagree the gateway returns `403 TENANT_MISMATCH`.

The same shared platform serves all three personas — the orchestrator core, tool router, calculation service, policy engine, memory layer, audit, and model router are identical (the resume's LangGraph ReAct + DAG + durable execution platform handling 10K+ runs/day, resume.txt:51–54). Persona specialization is expressed at three contract points only: the auth scope set, the request/response shape extensions, and the policy/HITL behavior bound to the persona claim.

---

## 2. Auth model

Edge auth uses **OAuth2 + OIDC** with PKCE for mobile/web SPAs and the **client_credentials** grant for partner/server-to-server callers. Identity tokens are short-lived JWTs (10 minutes, rotated against a 30-day refresh) issued by the IdP and minted with the following standard + custom claims:

```json
{
  "iss": "https://idp.bank-ai.example.com",
  "sub": "user_8f3...",
  "aud": "api.bank-ai",
  "exp": 1716301800,
  "iat": 1716301200,
  "tnt": "tenant_acme_co",
  "persona": "sme",
  "scopes": ["chat:send", "actions:propose", "actions:approve:tier1"],
  "ent": ["acct:1234", "acct:1235"],
  "auth_level": "mfa",
  "jti": "uuid-..."
}
```

| Scope | Meaning | Personas |
|-------|---------|----------|
| `chat:send` | Send messages to a session | retail, sme, cfo |
| `chat:read` | Read session history | retail, sme, cfo |
| `insights:read` | List proactive insights | retail, sme, cfo |
| `actions:propose` | Propose financial actions | sme, cfo |
| `actions:approve:tier1` | Single-approver tier | sme reviewer |
| `actions:approve:tier2` | Multi-approver chain | cfo reviewer |
| `actions:approve:tier3` | Treasury / high-value | cfo treasurer |
| `audit:read` | Query audit log | auditor role |

Internal service-to-service traffic uses **mTLS over a service mesh** (Istio or Linkerd). Every gRPC call also carries the original end-user JWT in a `forwarded-auth` metadata header so downstream services can re-authorize without trusting the upstream. The Orchestrator never elevates its identity — it always executes tools, model calls, and memory writes under the calling user's effective principal so the audit log carries the right `actor_id` (resume.txt:49–50 — same WASM sandbox plane discipline applied to identity propagation).

Auth-level requirements per scope are enforced at the gateway: `actions:approve:tier3` requires `auth_level=mfa+webauthn` and a re-auth no older than 5 minutes.

---

## 3. External REST API

### 3.1 `POST /v1/sessions` — start a chat session

**Scopes:** `chat:send`. **Idempotent:** yes (`Idempotency-Key` header).

```http
POST /tenant_acme_co/v1/sessions HTTP/1.1
Authorization: Bearer eyJ...
Idempotency-Key: 5ab1c2de-0f3a-4b7c-8e9f-aabbccddeeff
Content-Type: application/json

{
  "channel": "mobile_app",
  "locale": "en-US",
  "context_hint": {"screen": "home", "last_account_viewed": "acct:1234"}
}
```

Response:

```json
{
  "session_id": "ses_01HZK...",
  "persona": "retail",
  "tenant_id": "tenant_acme_co",
  "created_at": "2026-05-21T18:00:00Z",
  "expires_at": "2026-05-22T18:00:00Z",
  "policy_profile_id": "pp_retail_v37"
}
```

The persona is derived server-side from the JWT `persona` claim plus the user's entitlement record; clients cannot ask for a different persona. The `policy_profile_id` is returned so the client can warn the user when policy gates change (for example, a new regulation tightens what the SME persona will execute automatically).

### 3.2 `POST /v1/sessions/{id}/messages` — non-streaming send

**Scopes:** `chat:send`. **Idempotent:** yes — required.

```http
POST /tenant_acme_co/v1/sessions/ses_01HZK.../messages HTTP/1.1
Authorization: Bearer eyJ...
Idempotency-Key: c9f2c0a1-1111-2222-3333-444455556666
Content-Type: application/json

{
  "message_id_client": "msg_local_42",
  "content": {"type": "text", "text": "How much did I spend on food this month?"},
  "client_context": {"device": "iPhone 15 Pro", "app_version": "4.18.2"}
}
```

Response (sync, simplified):

```json
{
  "message_id": "msg_01HZL...",
  "session_id": "ses_01HZK...",
  "run_id": "run_01HZL...",
  "status": "completed",
  "reply": {
    "type": "text",
    "text": "You've spent $342.18 on food in May...",
    "rich_blocks": [{"type": "stat", "label": "Food MTD", "value": 342.18, "currency": "USD"}]
  },
  "tool_calls": [
    {"tool_id": "txn.summarize", "latency_ms": 84, "cache": "hit"}
  ],
  "model": {"id": "claude-sonnet", "tokens_in": 1240, "tokens_out": 187, "router_reason": "default_tier"},
  "confidence": 0.91,
  "trace_id": "tr_a1b2c3d4"
}
```

### 3.3 `POST /v1/sessions/{id}/messages:stream` — SSE streaming

**Scopes:** `chat:send`. **Idempotent:** yes. Response is `text/event-stream`. Each event has a typed `event:` line and a JSON `data:` line.

| Event | When fired | Data schema |
|-------|-----------|-------------|
| `run.started` | Orchestrator accepted the message | `{run_id, persona}` |
| `plan.delta` | Planner node emitted a step | `{step_no, node, summary}` |
| `tool.call.started` | A tool is being invoked | `{tool_id, args_redacted}` |
| `tool.call.completed` | Tool returned | `{tool_id, latency_ms, cache}` |
| `token` | Model token chunk | `{delta}` |
| `policy.gate` | Policy engine intervened (e.g., scope refusal) | `{rule_id, decision}` |
| `hitl.required` | Action requires approval | `{action_id, risk_tier}` |
| `confidence` | Final confidence score | `{score}` |
| `run.completed` | Terminal | `{run_id, status}` |
| `run.error` | Terminal error | `{code, message, retriable}` |

The client must accept that an SSE stream can finish in `run.error` *after* partial `token` events; the UI is expected to show the partial reply but mark it incomplete. The server flushes a heartbeat comment every 15s to keep proxies from killing the connection.

### 3.4 `GET /v1/sessions/{id}/messages` — paginated history

```
GET /tenant_acme_co/v1/sessions/ses_01HZK.../messages?cursor=eyJ...&limit=50&direction=backward
```

Returns a page of messages with `next_cursor` and `prev_cursor`. Each message is decorated with the `run_id` so the client can drill into the trace via `/v1/audit`.

### 3.5 `GET /v1/insights/proactive`

**Scopes:** `insights:read`. Returns active proactive insights the user has not yet acked or dismissed.

```json
{
  "items": [
    {
      "insight_id": "ins_01HZ...",
      "kind": "budget_breach",
      "severity": "warn",
      "title": "Dining budget 90% used with 11 days left",
      "rendered_at": "2026-05-21T13:14:00Z",
      "cooldown_key": "user:8f3:budget:dining:2026-05",
      "actions_offered": [{"action_id_template": "act_propose_budget_realloc"}]
    }
  ],
  "next_cursor": null
}
```

### 3.6 `POST /v1/insights/proactive/{id}/dismiss`

Body is optional; if present, may carry `reason` (`not_useful`, `already_handled`, `wrong_timing`). The dismiss reason becomes a feedback signal for the trigger evaluator's relevance score and feeds into the cooldown extension policy.

### 3.7 `POST /v1/actions` — propose an action

**Scopes:** `actions:propose`. **Idempotent:** required.

```json
{
  "type": "delay_vendor_payment",
  "params": {
    "vendor_id": "vnd_acme_logistics",
    "invoice_id": "inv_2026_004412",
    "current_due": "2026-05-25",
    "proposed_due": "2026-06-04",
    "reason": "preserve runway"
  },
  "session_id": "ses_01HZK...",
  "run_id": "run_01HZL...",
  "client_intent_text": "Push the Acme Logistics invoice to next week"
}
```

Response:

```json
{
  "action_id": "act_01HZM...",
  "type": "delay_vendor_payment",
  "status": "pending_approval",
  "risk_tier": 2,
  "approval_ticket_id": "tkt_01HZM...",
  "reviewer_pool": ["user_cfo_assistant", "user_cfo"],
  "expected_decision_by": "2026-05-21T19:00:00Z",
  "policy_trace_id": "pol_tr_88a2"
}
```

`status` is one of `pending_approval`, `auto_approved`, `queued`, `executing`, `executed`, `failed`, `rolled_back`, `rejected`, `expired`. A non-existent action proposal (idempotency hit for the same `Idempotency-Key`) replays the original response with `Idempotent-Replay: true` header.

### 3.8 `POST /v1/actions/{id}/approve`

**Scopes:** `actions:approve:tier{1,2,3}` matching the action's `risk_tier`. Reviewer must be in the action's `reviewer_pool`. Body:

```json
{
  "decision": "approve",
  "reviewer_note": "Cash position confirmed; vendor agreed verbally.",
  "auth_proof": {"webauthn_assertion": "..."}
}
```

For multi-approver actions (CFO tier-3) the response includes `remaining_approvers` until the chain completes.

### 3.9 `GET /v1/actions/{id}` — poll state

Returns the full action record (status, approvals collected so far, execution result if executed, rollback chain, audit pointer).

### 3.10 `POST /v1/feedback`

```json
{
  "target_type": "message",
  "target_id": "msg_01HZL...",
  "rating": "not_helpful",
  "reason_codes": ["wrong_answer", "missing_context"],
  "free_text": "It used last month's budget instead of this month's"
}
```

### 3.11 `GET /v1/audit` — auditor query

**Scopes:** `audit:read`. Restricted by tenant. Supports filter by `actor_id`, `event_type`, `from`, `to`, `action_id`, `run_id`. Returns hash-chained entries (see `05-low-level-design.md §3` for the chain schema) so the auditor can verify tamper evidence externally.

```
GET /tenant_acme_co/v1/audit?from=2026-05-01&event_type=action.executed&limit=100
```

---

## 4. WebSocket / SSE streaming protocol details

Streaming uses SSE rather than WebSocket because:

- Mobile and CDN-friendly (HTTP/2 multiplexed).
- One-way server push fits the chat reply model; the user submits messages over plain POST.
- Reconnection with `Last-Event-ID` lets clients resume mid-stream after a flap.

The server assigns a monotonically increasing `id:` to every event and re-emits the buffered tail from a Redis ring buffer (15 minutes, keyed by `run_id`) when the client reconnects with `Last-Event-ID`. If the client reconnects after the buffer window, the server emits a `run.resync` event and the client re-fetches the message via `GET /v1/sessions/{id}/messages`.

Token-level events are emitted as the model router (Claude/GPT/Grok, resume.txt:55–56) returns chunks. Tool calls and policy gates are surfaced *before* token emission so the UI can render a "thinking… (looking up account)" indicator with the tool name.

---

## 5. Idempotency model

| Aspect | Behavior |
|--------|----------|
| Header | `Idempotency-Key: <uuid v4>` |
| Required on | `POST /sessions`, `POST /messages`, `POST /messages:stream`, `POST /actions`, `POST /actions/{id}/approve` |
| Optional on | `POST /feedback`, `POST /insights/.../dismiss` |
| Dedup window | 24h |
| Dedup scope | `(tenant_id, user_id, route, idempotency_key)` |
| Hit response | Replays original status + body, adds `Idempotent-Replay: true` |
| Conflict | If a key was used with a different body hash → `409 IDEMPOTENCY_CONFLICT` |
| Inflight | If the original is still inflight, the second call blocks up to 5s for it or returns `425 IDEMPOTENCY_INFLIGHT` |

Internally the dedup store is Redis (`idem:{tenant}:{user}:{route}:{key} → {status, body_hash, response_ref, expires_at}`). Actions also persist an idempotency anchor in Postgres (`actions.client_idempotency_key UNIQUE`) so that recovery after Redis failure still de-duplicates.

---

## 6. Error model

All errors share the envelope:

```json
{
  "error": {
    "code": "POLICY_BLOCKED",
    "message": "This action exceeds the configured single-payment limit for SME persona.",
    "retriable": false,
    "trace_id": "tr_a1b2c3d4",
    "hint": "Ask a CFO-tier reviewer to approve, or split the payment.",
    "details": {"rule_id": "policy.sme.single_payment_cap", "limit": 50000, "actual": 73450}
  }
}
```

| Code | HTTP | Retriable | Meaning |
|------|------|-----------|---------|
| `INVALID_PERSONA` | 403 | no | JWT persona claim is missing or unknown |
| `TOOL_UNAVAILABLE` | 503 | yes (backoff) | Tool router circuit breaker open |
| `POLICY_BLOCKED` | 403 | no | Policy engine refused the action |
| `INSUFFICIENT_CONFIDENCE` | 422 | no | Agent confidence below tier threshold |
| `RATE_LIMITED` | 429 | yes (Retry-After) | Per-user or per-tenant quota exceeded |
| `MODEL_UNAVAILABLE` | 503 | yes (router will retry) | All routed models failed |
| `CALC_FAILED` | 422 | conditional | Deterministic calc rejected inputs |
| `APPROVAL_REQUIRED` | 202 | n/a | Returned with action in `pending_approval` |
| `TENANT_QUOTA_EXCEEDED` | 429 | yes after cycle | Monthly cost / token cap hit |
| `IDEMPOTENCY_CONFLICT` | 409 | no | Same key, different body |
| `IDEMPOTENCY_INFLIGHT` | 425 | yes | Original still in progress |
| `TENANT_MISMATCH` | 403 | no | URL tenant ≠ JWT tenant |
| `SESSION_EXPIRED` | 410 | no | Session past TTL; create a new one |
| `VALIDATION_ERROR` | 400 | no | Schema/shape errors with `details.fields[]` |
| `INTERNAL` | 500 | yes | Generic; include `trace_id` |

Standard 4xx/5xx mapping otherwise per RFC 9110. `Retry-After` is set on every 429 and on retriable 503s.

---

## 7. Internal contracts (gRPC, proto-style)

All internal RPCs include a `RunContext` carrying `run_id`, `tenant_id`, `user_id`, `persona`, `parent_step_id`, `trace_id`, and `deadline`. The Orchestrator is the only caller of these services in steady state.

### 7.1 Tool Router

```proto
service ToolRouter {
  rpc Invoke(InvokeRequest) returns (ToolResult);
  rpc Describe(DescribeRequest) returns (ToolCatalog);
}

message InvokeRequest {
  RunContext ctx = 1;
  string tool_id = 2;           // e.g., "txn.summarize", "payments.delay_vendor"
  google.protobuf.Struct params = 3;
  bool requires_sandbox = 4;     // routes to WASM sandbox plane if true
  int32 timeout_ms = 5;
}

message ToolResult {
  oneof body { google.protobuf.Struct ok = 1; ToolError err = 2; }
  int32 latency_ms = 3;
  string cache = 4;              // "miss" | "hit" | "stale-while-revalidate"
  string sandbox_attestation_id = 5; // present iff sandboxed
}
```

Risky tools execute inside the **WASM sandbox plane carried over from the SOC-2 compliance lineage** (resume.txt:49–50). The sandbox returns a signed attestation of the input/output and instruction count; the Orchestrator stores it in the run step record.

### 7.2 Context Manager

```proto
service ContextManager {
  rpc Build(BuildRequest) returns (Context);
}

message BuildRequest {
  RunContext ctx = 1;
  Persona persona = 2;
  RecencyWindow recency = 3;     // e.g., last 10 turns, last 30 days txns
  repeated string capability_hints = 4; // tools the planner may want
}

message Context {
  SessionSnapshot session = 1;
  UserProfile profile = 2;        // long-term
  FinancialSummary finance = 3;   // historical
  OrgContext org = 4;             // SME/CFO only
  repeated CitationRef citations = 5;
  int32 token_budget = 6;
  string context_hash = 7;
}
```

### 7.3 Policy Engine

```proto
service PolicyEngine {
  rpc Evaluate(EvaluateRequest) returns (Decision);
}

message EvaluateRequest {
  RunContext ctx = 1;
  ActionIntent intent = 2;       // type + params + estimated impact
  RiskSignals signals = 3;       // confidence, novelty, monetary impact
  Persona persona = 4;
}

message Decision {
  RiskTier tier = 1;             // TIER_0_AUTO | TIER_1 | TIER_2 | TIER_3_TREASURY
  repeated Gate gates = 2;       // e.g., REQUIRE_MFA, REQUIRE_DUAL_APPROVAL
  repeated string policy_rule_ids = 3;
  string decision_id = 4;
}
```

### 7.4 Calculation Service

```proto
service CalcService {
  rpc Compute(ComputeRequest) returns (ComputeResult);
}

message ComputeRequest {
  RunContext ctx = 1;
  string formula_id = 2;         // e.g., "cash_runway_v3", "loan.amort.v1"
  google.protobuf.Struct inputs = 3;
  bool require_explainability = 4;
}

message ComputeResult {
  google.protobuf.Value value = 1;
  Provenance provenance = 2;     // input hashes + formula version + worker id
  string deterministic_hash = 3;
}
```

The Calc Service is **deterministic by construction** — it never calls an LLM. Given the same `formula_id` + input hash it produces the same output hash and stores the result in a content-addressed cache. This is the trust boundary the model is *not* allowed to cross.

### 7.5 Memory Service

```proto
service MemoryService {
  rpc ReadSession(SessionKey) returns (SessionState);
  rpc WriteSession(SessionWrite) returns (Ack);
  rpc ReadProfile(UserKey) returns (UserProfile);
  rpc UpsertProfileFact(ProfileFactWrite) returns (Ack);
  rpc QueryFinancial(FinancialQuery) returns (FinancialResult);
  rpc QueryOrg(OrgQuery) returns (OrgResult);
}
```

Full memory tier schema is in `13-memory-layer-design.md`.

### 7.6 Approval Service

```proto
service ApprovalService {
  rpc Open(OpenTicket) returns (ApprovalTicket);
  rpc Decide(DecideRequest) returns (ApprovalTicket);
  rpc Get(TicketKey) returns (ApprovalTicket);
}

message OpenTicket {
  RunContext ctx = 1;
  string action_id = 2;
  repeated string reviewer_pool = 3;
  RiskTier tier = 4;
  google.protobuf.Timestamp sla_at = 5;
}
```

### 7.7 Model Router

```proto
service ModelRouter {
  rpc Chat(ChatRequest) returns (stream ChatChunk);
}

message ChatRequest {
  RunContext ctx = 1;
  repeated Message messages = 2;
  CapabilityHints hints = 3;     // structured_output? long_context? cheap_ok?
  int32 max_tokens = 4;
  float temperature = 5;
}
```

The Model Router routes across **Claude, GPT, and Grok at 1B+ tokens/month** (resume.txt:55–56), choosing by `(capability_hints, cost_class, persona_pref, current_health)`. Per-provider circuit breakers + per-tenant token budgets are enforced inside the router, not in the orchestrator.

### 7.8 Notification Orchestrator

The Notification Orchestrator is the only service that talks to user channels. It consumes from `proactive.insight.emitted.v1` and `approval.requested.v1` topics, applies channel selection (push > in-app > email > SMS by user preference and severity), and writes to the `notifications` table via the outbox pattern: insertion of an outbox row in the same transaction as the inbound event commit, then an async dispatcher flushes to channel APIs (APNs, FCM, Twilio, SendGrid). Idempotency on dispatch is keyed by `(notification_id, channel)`.

---

## 8. Event schemas (Kafka)

All events share an envelope:

```json
{
  "schema_version": 1,
  "event_id": "evt_01HZM...",
  "occurred_at": "2026-05-21T18:00:00Z",
  "tenant_id": "tenant_acme_co",
  "persona": "sme",
  "actor_id": "user_8f3...",
  "trace_id": "tr_a1b2c3d4",
  "payload": { /* topic-specific */ }
}
```

Topic partitioning is by `tenant_id` to preserve per-tenant ordering and to enforce per-tenant quotas at consumer lag. Retention is 7 days for raw event topics and 90 days for audit topics.

| Topic | Producer | Consumer(s) | Payload (abbreviated) |
|-------|----------|-------------|------------------------|
| `transactions.ingested.v1` | Ingestion pipeline | Trigger evaluator, Memory writer | `{account_id, txn_id, amount, currency, posted_at, mcc, counterparty}` |
| `budget.breach.v1` | Budget rule engine | Trigger evaluator | `{user_id, budget_id, category, mtd_spend, budget, breach_pct}` |
| `salary.credit.v1` | Ingestion pipeline | Trigger evaluator | `{user_id, account_id, amount, posted_at, recurring_hint}` |
| `fx.exposure.changed.v1` | Treasury monitor | Trigger evaluator | `{tenant_id, entity_id, ccy_pair, exposure_before, exposure_after}` |
| `treasury.imbalance.v1` | Treasury monitor | Trigger evaluator | `{tenant_id, account_id, target_buffer, current, gap}` |
| `approval.requested.v1` | Approval Service | Notification Orchestrator | `{ticket_id, action_id, reviewer_pool, sla_at}` |
| `approval.decided.v1` | Approval Service | Orchestrator (resume), Audit writer | `{ticket_id, decision, decided_by, decided_at}` |
| `proactive.insight.emitted.v1` | Trigger evaluator | Notification Orchestrator | `{insight_id, user_id, kind, severity, payload, cooldown_key}` |
| `audit.entry.v1` | Audit writer | Audit log Postgres | `{entry_id, prior_hash, payload_hash, event_type}` |

Schemas are registered in a Confluent-compatible registry; producers and consumers are pinned by `(topic, schema_version)`. Breaking changes bump the version suffix (`.v2`) and run dual-write for a deprecation window of 30 days.

---

## 9. Persona-specific contract differences

The shared platform handles all three personas, but three contract surfaces differ. The differences are **declarative** — encoded in a `persona_profile` document the gateway loads at request time — so the orchestrator code path is the same.

| Concern | Retail | SME | CFO |
|---------|--------|-----|-----|
| Action shapes | Nudge-only (`type: "budget_reminder"`, `"savings_suggestion"`) | Vendor / AR / AP (`delay_vendor_payment`, `accelerate_collection`, `reclassify_expense`) | + Sub-entity, treasury (`fx_hedge`, `intercompany_transfer`, `revolver_drawdown`) |
| Approval flow | None — all actions are user-confirmed in-chat | Single approver from `reviewer_pool` | Multi-approver chain (initiator + reviewer + treasurer) for tier-3 |
| HITL risk-tier cap | Tier-0 only (no monetary impact) | Tier-0 + tier-1 (≤ $50K) | All tiers |
| Confidence threshold for auto | 0.70 (nudge) | 0.85 | 0.90 (auto), 0.95 for tier-2 auto |
| Proactive event types | budget breach, salary credit | + AR/AP cycle, vendor schedule | + treasury imbalance, FX, covenant |
| Audit retention | 1 year | 7 years | 10 years + WORM bucket |
| Context shape | Profile + 12 mo financial | + Org context (vendors, AR/AP) | + Sub-entity tree, approver graph, treasury accounts |
| Notification channels | Push primary, email fallback | + In-app priority queue | + Email + on-call escalation paging |

These differences are enforced at three points:

1. **Gateway**: scope check rejects `actions:propose` with retail JWT.
2. **Policy Engine**: persona-bound rule set is loaded per request.
3. **Context Manager**: builds the right shape (`org` block only for sme/cfo).

The agent graph topology in `12-agentic-graph-structure.md` is the same — supervisor + tool-using sub-agents + critic + memory writer — with persona-specific nodes only conditionally activated.

---

## 10. Sample request/response pairs

### 10.1 Retail — chat (food spend question)

Request: see §3.2 above.

Response (note: no action, no approval, retail keeps it simple):

```json
{
  "message_id": "msg_01HZL...",
  "reply": {
    "type": "text",
    "text": "You've spent $342.18 on food in May, which is 76% of your $450 budget. At your current pace you'll land around $440 — right under the cap.",
    "rich_blocks": [
      {"type": "progress", "label": "Food MTD", "value": 342.18, "max": 450, "currency": "USD"},
      {"type": "forecast", "label": "Projected EOM", "value": 440.20, "currency": "USD"}
    ]
  },
  "confidence": 0.93
}
```

### 10.2 Retail — proactive insight (salary credit + savings nudge)

```json
{
  "insight_id": "ins_01HZSA...",
  "kind": "salary_credit_nudge",
  "severity": "info",
  "title": "Salary credited — want to auto-move $200 to savings?",
  "actions_offered": [
    {"action_id_template": "act_propose_auto_save", "params": {"amount": 200, "destination": "acct_savings_main"}}
  ]
}
```

### 10.3 SME — chat (cashflow question)

```json
{
  "content": {"type": "text", "text": "What's my runway if I delay the Acme Logistics invoice 10 days?"}
}
```

Response includes a computation citation: `tool_calls` carries `cash_runway_v3` and the response cites the deterministic calc service result (resume.txt:51–54 — durable execution lets the run be replayed without re-running the LLM).

### 10.4 SME — action proposal + single-approver HITL

```http
POST /v1/actions
{
  "type": "delay_vendor_payment",
  "params": {"vendor_id": "vnd_acme_logistics", "invoice_id": "inv_2026_004412", "current_due": "2026-05-25", "proposed_due": "2026-06-04"},
  "session_id": "ses_01HZK...",
  "run_id": "run_01HZL..."
}
```

Response: 202 with `status: "pending_approval"`, `risk_tier: 2`, `reviewer_pool: ["user_cfo_assistant"]`. The reviewer's mobile app receives a push from the Notification Orchestrator and approves via `POST /v1/actions/{id}/approve` with a WebAuthn assertion. The orchestrator resumes the durable run from the `waiting_for_hitl` checkpoint, executes via the WASM sandbox (resume.txt:49–50), and writes an `action.executed` audit entry.

### 10.5 CFO — chat (treasury balancing)

```json
{
  "content": {"type": "text", "text": "Rebalance EUR exposure across UK and DE entities to stay within ±2% policy."}
}
```

Reply preview:

```json
{
  "reply": {
    "type": "text",
    "text": "EUR exposure is currently +3.4%. To return to ±2%, I propose: intercompany transfer of €1.4M from DE to UK, then a 1-month forward of €600K. Estimated FX impact +€2,300.",
    "rich_blocks": [
      {"type": "table", "title": "Proposed transactions", "rows": [
        {"entity": "DE Op Co", "leg": "out", "ccy": "EUR", "amount": 1400000},
        {"entity": "UK Op Co", "leg": "in", "ccy": "EUR", "amount": 1400000},
        {"entity": "Treasury", "leg": "hedge", "ccy": "EUR", "amount": 600000, "tenor": "1M"}
      ]}
    ]
  },
  "confidence": 0.94,
  "actions_offered": [
    {"action_id_template": "act_propose_intercompany_transfer", "risk_tier": 2},
    {"action_id_template": "act_propose_fx_hedge", "risk_tier": 3}
  ]
}
```

### 10.6 CFO — multi-approver tier-3 action

```http
POST /v1/actions
{
  "type": "fx_hedge",
  "params": {"ccy_pair": "EURUSD", "notional": 600000, "tenor": "1M", "side": "sell_eur"}
}
```

Response: `status: "pending_approval"`, `risk_tier: 3`, `reviewer_pool: ["user_cfo", "user_treasurer"]`, `gates: ["REQUIRE_MFA", "REQUIRE_DUAL_APPROVAL", "REQUIRE_FRESH_AUTH_5M"]`. Both reviewers must approve via separate `POST /approve` calls with WebAuthn assertions; the second approval flips `status` to `executing` and the run resumes.

---

## 11. Rate limits and quotas

| Limit | Scope | Default | Header |
|-------|-------|---------|--------|
| Messages / minute | per user | 30 retail, 60 sme, 120 cfo | `X-RateLimit-User-*` |
| Actions / hour | per user | 20 sme, 60 cfo | `X-RateLimit-Actions-*` |
| Model tokens / day | per tenant | tier-dependent | `X-Tenant-Token-Budget-*` |
| Streaming connections | per user | 4 concurrent | — |
| Approval polls / minute | per ticket | 12 | — |

Quotas roll up to the tenant token budget so a single noisy user cannot starve the rest of the tenant. The Model Router enforces the token quota at chat time; exhaustion returns `TENANT_QUOTA_EXCEEDED` and the orchestrator emits a `quota.exceeded` audit entry.

---

## 12. Versioning, deprecation, and SDK stance

- URL versioning (`/v1`) for breaking changes only.
- Additive JSON fields are permitted within a major version; clients must ignore unknown fields.
- A removed field requires a 90-day deprecation header (`Deprecation: true; Sunset: 2026-08-21`).
- SDKs (TypeScript, Swift, Kotlin, Python) are generated from the OpenAPI spec for REST and the `.proto` files for internal contracts; the OpenAPI spec is the source of truth for external clients.
- Internal proto contracts use semantic version tags on the service mesh (`tool-router-v3.4.1`), and the Orchestrator pins a minor-version range per environment.

---

## 13. Summary

This contract layer carries the persona-aware divergence (action shapes, approval flow, retention, channels) while keeping the **core platform identical** for all three personas — the same LangGraph durable orchestrator (resume.txt:51–54), the same model router across Claude/GPT/Grok (resume.txt:55–56), the same WASM sandbox plane for risky tool execution (resume.txt:49–50), and the same audit/HITL machinery. Internal contracts are gRPC + Kafka; external contracts are REST + SSE with mandatory idempotency, hash-chained audit, and a uniform error envelope. Implementation details follow in `05-low-level-design.md`.
