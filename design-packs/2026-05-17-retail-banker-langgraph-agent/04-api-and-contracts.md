# 04 - API and Contracts

Two contract layers exist:

1. **External HTTP/WebSocket API** — what the bank app, WhatsApp adapter, and
   branch banker UI call.
2. **Internal tool registry** — what nodes inside the LangGraph DAG call. Every
   tool has a Pydantic input/output schema and a JSON-schema export for
   LLM tool-calling.

## 1. External API

### `POST /v1/conversations`

Start (or resume) a conversation. Returns a `session_id` plus a
short-lived `turn_token` for the next message.

```http
POST /v1/conversations
Authorization: Bearer <user_jwt>
Content-Type: application/json

{
  "customer_id": "cust_8f3a...",
  "locale": "hi-IN",
  "channel": "app",
  "client_session_id": "ui-7c2e..."   // dedup key from client
}
```

Response:

```json
{
  "session_id": "sess_01HXZ...",
  "expires_at": "2026-05-17T13:00:00Z",
  "turn_token": "tt_..."
}
```

### `POST /v1/conversations/{session_id}/turns`

Send one user message; receive one structured response.

```json
{
  "turn_token": "tt_...",
  "message": "Why did my balance drop this week?",
  "client_turn_id": "ui-9aa1...",   // idempotency
  "context": { "ui": "balance_screen" }
}
```

Response (always the same envelope, never raw LLM text):

```json
{
  "turn_id": "turn_01HXZ...",
  "explanation": {
    "headline": "Your balance is down ₹18,200 vs last week.",
    "drivers": [
      {"label": "Travel", "amount": -9100, "share": 0.50},
      {"label": "Shopping", "amount": -6400, "share": 0.35},
      {"label": "Fixed (rent, EMI)", "amount": -2700, "share": 0.15}
    ],
    "recommendation": "Cut discretionary spend by ₹10,000 to stay on track.",
    "confidence": "high",
    "citations": [
      {"type": "txn", "ref": "txn_abc123"},
      {"type": "calc", "ref": "spend.aggregate#v3"}
    ],
    "language": "hi-IN"
  },
  "actions_offered": [
    {"id": "set_weekly_alert", "label": "Alert me if I cross ₹12k/week", "risk": "safe"}
  ],
  "trace_id": "01HXZ..."
}
```

### `POST /v1/conversations/{session_id}/turns/{turn_id}/actions`

Confirm an offered action (separates *suggestion* from *execution*).

```json
{ "action_id": "set_weekly_alert", "confirm": true }
```

The server validates `action_id` against `actions_offered` for the turn —
clients cannot synthesize actions out of band. This is the seam where
**HITL** lives: a money-moving action's confirmation can be gated on a
second-factor or banker approval.

### `GET /v1/conversations/{session_id}/trace/{turn_id}` *(internal only)*

Returns the full replay bundle for an audit / dispute: node-by-node
state diffs, tool inputs/outputs (PII-redacted in transit, full in
audit zone), model IDs, prompt hashes, latencies.

### `WS /v1/conversations/{session_id}/stream`

Optional streaming variant. Emits `{event, payload}` frames as the DAG
progresses:

| Event | Payload |
|---|---|
| `node.start` | `{node, ts}` |
| `tool.call` | `{tool, args_hash}` |
| `tool.result` | `{tool, ms, ok}` |
| `partial.headline` | `{text}` |
| `done` | `{turn_id, explanation, actions_offered}` |
| `error` | `{code, retryable}` |

Streaming keeps perceived latency low even when the deep-analysis path
takes 8-12 seconds.

### Errors

| HTTP | Code | Meaning | Retryable |
|---|---|---|---|
| 400 | `bad_request` | malformed body | no |
| 401 | `unauthorized` | bad token | no |
| 403 | `policy_denied` | action refused by policy engine | no |
| 409 | `idempotency_conflict` | `client_turn_id` reused with different payload | no |
| 422 | `tool_unavailable` | downstream Core Banking degraded | yes (after backoff) |
| 423 | `pending_approval` | action queued for HITL | no (poll `/actions/{id}`) |
| 429 | `rate_limited` | per-user budget exceeded | yes (after `Retry-After`) |
| 500 | `internal` | unexpected | yes |
| 503 | `degraded` | LLM provider failover in progress | yes |

## 2. Internal tool registry

Every tool the DAG can call is registered once. The registry produces:

- A Python callable (`tool.run(input)`).
- A Pydantic input/output schema (for static typing + unit tests).
- A JSON schema (for LLM tool-calling).
- An OTel span template (for observability).
- A policy descriptor (`side_effect`, `cost`, `pii_class`).

### Registry entry shape

```python
@tool(
    name="spend.aggregate",
    version="3",
    description="Aggregate transactions by category over a window.",
    input_schema=AggregateInput,
    output_schema=AggregateOutput,
    side_effect=False,          # pure read
    cost="cheap",               # for budgeter
    timeout_s=0.5,
    pii_class="user_txn",
    rate_limit=RateLimit(per_user="50/min"),
)
def spend_aggregate(inp: AggregateInput) -> AggregateOutput: ...
```

### Catalog (MVP)

| Tool | Side effect | Allowed callers | Notes |
|---|---|---|---|
| `core_banking.get_balances` | read | `context_fetch` | mTLS to Core Banking |
| `core_banking.get_cards` | read | `context_fetch` | |
| `txn_query.list` | read | `context_fetch`, `risk_agent`, `budget_agent` | windowed |
| `txn_query.by_id` | read | `risk_agent` | single txn lookup |
| `goals_store.list` | read | `context_fetch`, `budget_agent`, `savings_agent` | |
| `goals_store.upsert` | write | `action_executor` only | HITL? no (low risk) |
| `fraud_rules.eval` | read (pure) | `calc`, `risk_agent` | versioned rule pack |
| `geo.lookup` | read | `risk_agent` | IP→country, merchant→city |
| `device.fingerprint` | read | `risk_agent` | hashed device id |
| `emi.calc` | read (pure) | `calc` | deterministic |
| `due.upcoming` | read (pure) | `calc` | deterministic |
| `fd_catalog.list` | read | `savings_agent` | rate sheet |
| `liquidity.forecast` | read | `savings_agent` | model-backed |
| `knowledge_base.lookup` | read | `budget_agent`, `explainer` | RAG over policy/help |
| `notification.send` | write | `action_executor` | idempotent |
| `support_ticket.create` | write | `action_executor` | idempotent |
| `reminder.create` | write | `action_executor` | idempotent |
| `dispute.file` | write | `action_executor` | HITL required |
| `fd.book` | write | (not in MVP) | HITL + 2FA |

### JSON schema example (LLM-facing for `spend.aggregate`)

```json
{
  "name": "spend.aggregate",
  "description": "Aggregate transactions by category over a window.",
  "parameters": {
    "type": "object",
    "properties": {
      "customer_id": {"type": "string"},
      "window_days": {"type": "integer", "minimum": 1, "maximum": 365},
      "group_by": {"type": "string", "enum": ["category", "merchant", "channel"]}
    },
    "required": ["customer_id", "window_days", "group_by"]
  }
}
```

### Idempotency contract for writes

Every write tool accepts an `idempotency_key` and stores
`(idempotency_key, output_hash)` for 24 h. Replays return the original
output without re-executing. The key is constructed as
`sha256(session_id || turn_id || tool_name || canonical(args))`.

### Tool-call request / response shape

The runtime wraps every tool call in this envelope (logged to the trace):

```json
{
  "call_id": "tc_01HXZ...",
  "tool": "spend.aggregate",
  "version": "3",
  "args": { "customer_id": "cust_***", "window_days": 7, "group_by": "category" },
  "args_hash": "sha256:...",
  "caller": {"node": "budget_agent", "iteration": 1},
  "started_at": "2026-05-17T12:34:56.123Z",
  "duration_ms": 87,
  "result": { /* AggregateOutput */ },
  "result_hash": "sha256:...",
  "ok": true,
  "trace_id": "01HXZ..."
}
```

This envelope is what makes the deterministic-replay story actually
work: replay = re-execute the DAG with the same tool envelopes pinned
(or, in shadow mode, re-executed against a captured fixture).

## 3. Memory contract

The session memory is split into three stores; agents access them through
typed accessors, never raw SQL.

| Store | Backing | Lifetime | Examples |
|---|---|---|---|
| **Working state** | in-process `BankerState` | one turn | intent, calc results, draft narrative |
| **Episodic memory** | Postgres `conversation_turns` | rolling 90 days | message history, prior explanations |
| **Long-term memory** | Postgres `user_facts` + pgvector | indefinite | goals, persona, declared preferences ("don't suggest credit cards") |

Memory writes from agents go through a **review gate**: an LLM proposal
to remember a fact is validated against a schema (`Fact { kind,
value, evidence_turn_id }`) and stored only if `confidence ≥ medium`.
This prevents the agent from hallucinating itself into a false belief
across sessions — the same memory-poisoning risk we've discussed in
the agent-memory-persistence pack.
