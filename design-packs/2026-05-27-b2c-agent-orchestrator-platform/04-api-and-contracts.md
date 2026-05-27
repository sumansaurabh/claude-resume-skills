# 04 — API and Contracts

External HTTP+JSON for users and SDKs, gRPC for service-to-service. Designed against the canonical service names in `03-architecture.md`. Anchored on AutoML's dual SDK+UI surface for 200K+ users (`resume.txt:90-92`) and BlackBox's ReAct agent runtime at 10K+ runs/day (`resume.txt:51-52`).

---

## A. Public API contract (external)

Base URL: `https://api.platform.example/v1`. All endpoints require `Authorization: Bearer <jwt>` except OAuth callback. All POST/PATCH/DELETE accept `Idempotency-Key: <uuid>` header. Errors follow the envelope in section F.

### A.1 Agents

#### `POST /v1/agents` — create agent

Brief: Create a new agent definition under the caller's namespace. Persona, connectors, skills, RAG sources, and memory config are all optional; an empty agent is a valid (chat-only) persona.

Request:
```json
{
  "name": "research-buddy",
  "persona": {
    "system_prompt": "You are a meticulous research assistant...",
    "traits": ["analytical", "concise", "cite-sources"],
    "default_model": "claude-sonnet-4-7"
  },
  "connectors": [
    { "type": "oauth", "provider": "gmail", "connector_id": "conn_01HX..." },
    { "type": "mcp", "endpoint_id": "mcp_01HX..." }
  ],
  "skills": ["skill_01HX...", "skill_01HY..."],
  "rag_sources": ["rag_src_01HX..."],
  "memory_config": {
    "working_memory_tokens": 8192,
    "episodic_retention_days": 30,
    "semantic_top_k": 6,
    "procedural_enabled": true
  },
  "guardrails": {
    "input_policy_id": "pol_default_b2c",
    "output_policy_id": "pol_default_b2c"
  }
}
```

Success (201):
```json
{
  "id": "agent_01HXABCDEFG",
  "version": 1,
  "owner_user_id": "user_01HX...",
  "name": "research-buddy",
  "created_at": "2026-05-27T11:04:21Z",
  "updated_at": "2026-05-27T11:04:21Z",
  "visibility": "private",
  "persona": { "...": "..." },
  "connectors": [ "..." ],
  "skills": [ "..." ],
  "rag_sources": [ "..." ]
}
```

Idempotency: Server stores `hash(idempotency_key + canonical_body)` keyed to the resulting `agent_id` for 24h. Repeat returns the original response with `X-Idempotent-Replay: true`.

Errors: `VALIDATION_PERSONA_TOO_LONG`, `VALIDATION_CONNECTOR_NOT_OWNED`, `QUOTA_AGENT_LIMIT_EXCEEDED`, `AUTH_FORBIDDEN`.

#### `GET /v1/agents/{id}`

Returns the latest version. Pin a specific version with `?version=N`. 404 on soft-deleted agents unless caller is owner with `?include_deleted=true`.

#### `PATCH /v1/agents/{id}`

Partial update via JSON merge patch. Bumps `agent_versions.version`. Active runs continue against the pinned version; new runs use the latest.

#### `DELETE /v1/agents/{id}`

Soft delete (sets `deleted_at`). Catalog listings are unpublished synchronously. Running runs are NOT cancelled; they finish on the pinned version.

#### `POST /v1/agents/{id}/publish`

Body: `{ "title": "...", "description": "...", "category": "research", "tags": ["..."] }`. Validates that the agent contains no private connector tokens or private RAG sources before publishing.

#### `POST /v1/agents/{id}/fork`

Forks a published agent into the caller's namespace. Persona, skill references, and RAG-source schemas are copied. OAuth tokens are NOT copied — the forker must re-link their own Gmail/Slack. The new agent gets `forked_from_id = <source_id>`.

Success (201): returns the new agent envelope identical to `POST /v1/agents`.

### A.2 Runs

#### `POST /v1/agents/{id}/runs` — start a run

Brief: Start an agent run. Returns immediately with `run_id`. If client sends `Accept: text/event-stream`, the same call upgrades to SSE and streams events until terminal.

Request:
```json
{
  "input": {
    "messages": [
      { "role": "user", "content": "Summarize my unread Stripe receipts from last week." }
    ]
  },
  "tools_overrides": { "gmail.search": { "max_results": 50 } },
  "memory_overrides": { "episodic_load": true },
  "budget": {
    "max_tokens": 200000,
    "max_tool_calls": 30,
    "max_wall_seconds": 300
  },
  "callbacks": {
    "webhook_url": "https://example.com/runs/cb"
  }
}
```

Success (202, JSON mode):
```json
{
  "run_id": "run_01HXRUNABCD",
  "agent_id": "agent_01HXABCDEFG",
  "agent_version": 4,
  "status": "queued",
  "created_at": "2026-05-27T11:10:02Z",
  "stream_url": "https://api.platform.example/v1/runs/run_01HXRUNABCD/stream"
}
```

Success (200, SSE mode): `Content-Type: text/event-stream`. See section C.

Idempotency: Repeat with same `Idempotency-Key` returns same `run_id`. Anchored on `microsoft-experience.md` point 24-25 — idempotency for AutoML job submission.

Errors: `QUOTA_RUNS_PER_MIN_EXCEEDED`, `QUOTA_TOKENS_DAILY_EXCEEDED`, `CONNECTOR_OAUTH_EXPIRED`, `GUARDRAIL_INPUT_BLOCKED`.

#### `GET /v1/runs/{run_id}`

Returns run state.

```json
{
  "run_id": "run_01HXRUNABCD",
  "agent_id": "agent_01HXABCDEFG",
  "agent_version": 4,
  "status": "completed",
  "started_at": "2026-05-27T11:10:03Z",
  "finished_at": "2026-05-27T11:10:42Z",
  "current_node_id": null,
  "usage": {
    "input_tokens": 14821,
    "output_tokens": 2104,
    "tool_calls": 7,
    "cost_usd": "0.1872"
  },
  "result": {
    "messages": [ { "role": "assistant", "content": "..." } ]
  },
  "error": null
}
```

#### `POST /v1/runs/{run_id}/cancel`

Sets status to `cancelling`. AgentRuntime checks the flag between nodes and at every tool boundary, transitions to `cancelled`, then runs the Compensating state machine (see `05-low-level-design.md` section B).

#### `POST /v1/runs/{run_id}/resume`

Used after `HITLPaused`. Body: `{ "approval": "approved" | "rejected", "comments": "...", "patched_args": { "...": "..." } }`. Re-enters the runtime from the checkpoint stored in `run_events`. Anchored on BlackBox durable resumable agents (`blackbox-experience.md` point 13).

#### `GET /v1/runs/{run_id}/events`

Paginated event log. Query: `?after_seq=120&limit=200`. Returns the same event envelope as section C, but as a JSON array. This is the durable, replay-safe event store (anchored on `resume.txt:58-59` deterministic replay and `blackbox-experience.md` point 20).

### A.3 Connectors

#### `POST /v1/connectors/oauth/{provider}/start`

`provider` ∈ `{gmail, slack, github, notion, gdrive}`. Returns redirect URL.

```json
{
  "redirect_url": "https://accounts.google.com/o/oauth2/v2/auth?...&state=oauth_state_01HX...",
  "state": "oauth_state_01HX...",
  "expires_at": "2026-05-27T11:25:00Z"
}
```

#### `POST /v1/connectors/oauth/{provider}/callback`

Body: `{ "code": "...", "state": "oauth_state_01HX..." }`. Exchanges code for access+refresh tokens, encrypts via Vault transit engine (see `05-low-level-design.md` section E), returns `connector_id`.

#### `POST /v1/connectors/mcp`

Register an MCP server.

```json
{
  "name": "my-jira",
  "url": "https://mcp.example.com/jira/sse",
  "auth": { "type": "bearer", "token": "..." },
  "scopes": ["issues.read", "issues.write"]
}
```

Returns `{ "endpoint_id": "mcp_01HX...", "capabilities": [...] }`. Capabilities are discovered via `tools/list` MCP RPC and cached for 1h.

### A.4 Skills

#### `POST /v1/skills` — upload a skill

Body is `multipart/form-data` with two parts:

- `manifest`: the parsed `SKILL.md` frontmatter (validated against the schema in `05-low-level-design.md` section F)
- `bundle`: a tarball containing `SKILL.md` + `scripts/`

```http
POST /v1/skills
Content-Type: multipart/form-data; boundary=----X
Idempotency-Key: 7c2b...

------X
Content-Disposition: form-data; name="manifest"
Content-Type: application/json

{
  "name": "stripe-receipts",
  "description": "Parse Stripe email receipts into structured rows",
  "allowed-tools": ["gmail.search", "gmail.get_message"],
  "scripts": ["scripts/parse.py"],
  "runtime": "python-wasi-3.12"
}
------X
Content-Disposition: form-data; name="bundle"; filename="bundle.tgz"
Content-Type: application/gzip

<binary>
------X--
```

Success (201):
```json
{
  "id": "skill_01HXSKILL...",
  "version": 1,
  "name": "stripe-receipts",
  "bundle_sha256": "9f1c...",
  "wasm_artifact_url": "s3://skills/skill_01HXSKILL/v1.wasm",
  "compiled": true,
  "owner_user_id": "user_01HX..."
}
```

Errors: `SKILL_MANIFEST_INVALID`, `SKILL_SYNTAX_ERROR`, `SKILL_DISALLOWED_TOOL`, `SKILL_BUNDLE_TOO_LARGE`.

#### `GET /v1/skills/{id}`

Returns manifest + version list. `?include_bundle=true` returns a signed S3 URL valid for 5 minutes.

### A.5 RAG sources

#### `POST /v1/rag/sources`

Three source kinds. The endpoint returns synchronously with `ingestion_job_id`; processing happens in `IngestionPipeline` (see `14-ingestion-pipeline.md`).

Request (URL crawl):
```json
{
  "name": "company-docs",
  "kind": "url_crawl",
  "url_crawl": {
    "seed_urls": ["https://docs.example.com/"],
    "max_pages": 5000,
    "include_globs": ["/docs/**"],
    "exclude_globs": ["/docs/legal/**"]
  },
  "embedder": "EmbedderTextV3",
  "chunking": { "size_tokens": 512, "overlap_tokens": 64 },
  "reindex_schedule": "daily"
}
```

Request (S3 prefix):
```json
{
  "name": "support-tickets-archive",
  "kind": "s3_prefix",
  "s3_prefix": {
    "bucket": "support-archive",
    "prefix": "tickets/2025/",
    "role_arn": "arn:aws:iam::123:role/PlatformRAGReader"
  },
  "embedder": "EmbedderTextV3"
}
```

Request (direct upload): returns a presigned URL set the client PUTs to.

Success (202):
```json
{
  "id": "rag_src_01HX...",
  "ingestion_job_id": "ing_01HX...",
  "status": "ingesting",
  "estimated_chunks": 48000
}
```

Errors: `RAG_SOURCE_QUOTA_EXCEEDED`, `RAG_EMBEDDER_UNAVAILABLE`.

### A.6 Catalog

#### `GET /v1/catalog/agents`

Query: `?q=research&category=productivity&sort=top|new|installs&page=1&page_size=20`. Returns published agents with install counts and ratings.

```json
{
  "page": 1,
  "page_size": 20,
  "total": 314,
  "items": [
    {
      "agent_id": "agent_01HX...",
      "title": "Inbox Triage Buddy",
      "description": "...",
      "category": "productivity",
      "tags": ["gmail", "summarization"],
      "install_count": 1842,
      "rating": 4.7,
      "owner": { "user_id": "user_01HX...", "display_name": "alice" }
    }
  ]
}
```

### A.7 Memory

#### `GET /v1/memory/inspect?agent_id=&user_id=`

Subject-scoped read. Returns a flat list of memory rows visible to the calling subject (the calling user's own memory for this agent only — never cross-tenant). Pagination via `?cursor=`.

```json
{
  "items": [
    {
      "memory_id": "mem_01HX...",
      "type": "EpisodicMemory",
      "summary": "User prefers concise bullet summaries.",
      "created_at": "2026-05-22T...",
      "source_run_id": "run_01HX..."
    }
  ],
  "next_cursor": "eyJv..."
}
```

#### `DELETE /v1/memory?agent_id=&type=`

GDPR right-to-erase. `type` ∈ `{WorkingMemory, EpisodicMemory, SemanticMemory, ProceduralMemory, all}`. Synchronously deletes the row from Postgres + tombstones the corresponding pgvector entries; an async job purges S3 attachments.

---

## B. Idempotency model

Header: `Idempotency-Key: <uuid>` accepted on all POST/PATCH/DELETE. Server computes `fingerprint = sha256(idempotency_key || canonical_json(body))` and persists `(user_id, route, fingerprint) → response_envelope` in `idempotency_keys` with 24h TTL.

Behavior:

1. First request: row inserted, request executes, response cached with `status_code` and body.
2. Repeat with same key + same body: cached response returned, header `X-Idempotent-Replay: true`.
3. Same key + different body: 409 `IDEMPOTENCY_KEY_CONFLICT`.
4. Concurrent duplicates: row insertion uses `INSERT ... ON CONFLICT DO NOTHING RETURNING`; the loser polls the row until populated (up to 5s), then returns the same payload.

Resume anchor: AutoML's job-submission idempotency at 15M+ jobs/month (`microsoft-experience.md` points 24-25, `resume.txt:90-92`). Same shape applies here for `POST /v1/agents/{id}/runs` and `POST /v1/skills`.

---

## C. Streaming model (SSE)

When the client sends `Accept: text/event-stream` to `POST /v1/agents/{id}/runs` (or `GET /v1/runs/{run_id}/stream`), the server upgrades to SSE.

Each event:
```
id: 47
event: tool.called
data: {"run_id":"run_01HX...","node_id":"toolcaller","seq":47,"ts":"2026-05-27T11:10:08.123Z","payload":{"tool_name":"gmail.search","args_redacted":true}}

```

Event types:

| Event                 | Emitted when                                                         |
| --------------------- | -------------------------------------------------------------------- |
| `run.started`         | Run dequeued, state -> Planning                                      |
| `node.entered`        | Any graph node entered (Planner, Router, ToolCaller, Critic, etc.)   |
| `tool.called`         | ToolCaller dispatched a call (args redacted by default)              |
| `tool.returned`       | Tool result available (size + truncation flag)                       |
| `model.token`         | ModelGateway emitted a token (only when client opts in)              |
| `memory.read`         | MemoryService returned K items                                       |
| `memory.write`        | A new working/episodic/semantic/procedural item was committed        |
| `hitl.requested`      | Run entered `HITLPaused` awaiting approval                           |
| `guardrail.triggered` | GuardrailService blocked/redacted input, output, or tool call        |
| `run.completed`       | Terminal success                                                     |
| `run.failed`          | Terminal failure with code + message                                 |

Every event carries `run_id`, `node_id`, `seq` (monotonic per run), `ts` (ISO-8601), `payload`. The `seq` field makes the SSE stream resumable: clients reconnect with `Last-Event-ID: 47` and the server replays from `run_events` (section A.2 / `05-low-level-design.md` section D). Anchored on BlackBox telemetry mesh for deterministic replay (`resume.txt:58-59`).

---

## D. Internal contracts (gRPC)

All internal RPCs use gRPC with mTLS (per-service SPIFFE identity) and propagate `run_id`, `node_id`, `tenant_id` via metadata. Trace context goes through OpenTelemetry's W3C propagators.

### D.1 `AgentRuntime ↔ MemoryService`

```proto
syntax = "proto3";
package memory.v1;

service MemoryService {
  rpc Read(ReadRequest) returns (ReadResponse);
  rpc Write(WriteRequest) returns (WriteResponse);
  rpc SemanticSearch(SemanticSearchRequest) returns (SemanticSearchResponse);
  rpc EpisodicLoad(EpisodicLoadRequest) returns (EpisodicLoadResponse);
  rpc ProceduralLookup(ProceduralLookupRequest) returns (ProceduralLookupResponse);
}

message ReadRequest {
  string tenant_id  = 1;
  string user_id    = 2;
  string agent_id   = 3;
  string run_id     = 4;
  MemoryType type   = 5;  // WORKING | EPISODIC | SEMANTIC | PROCEDURAL
}

message ReadResponse { repeated MemoryItem items = 1; }

message MemoryItem {
  string memory_id  = 1;
  MemoryType type   = 2;
  string content    = 3;
  bytes  embedding  = 4;     // only on SEMANTIC
  double score      = 5;     // only on SEMANTIC
  int64  created_at = 6;
  string source_run_id = 7;
}

message SemanticSearchRequest {
  string tenant_id = 1; string user_id = 2; string agent_id = 3;
  string query     = 4;
  int32  top_k     = 5;       // typical 6
  double min_score = 6;       // typical 0.55
  repeated string filter_tags = 7;
}

message WriteRequest {
  string tenant_id = 1; string user_id = 2; string agent_id = 3; string run_id = 4;
  MemoryType type  = 5;
  string content   = 6;
  repeated string tags = 7;
  int64 ttl_seconds = 8;      // 0 = persistent
}
```

p99 target: 25ms for `Read`/`Write`, 60ms for `SemanticSearch` (HNSW + bm25 hybrid, anchored on `resume.txt:60-61`).

### D.2 `AgentRuntime ↔ ConnectorBroker`

```proto
service ConnectorBroker {
  rpc ListCapabilities(ListCapabilitiesRequest) returns (ListCapabilitiesResponse);
  rpc InvokeTool(InvokeToolRequest)            returns (InvokeToolResponse);
  rpc OAuthRefresh(OAuthRefreshRequest)        returns (OAuthRefreshResponse);
}

message InvokeToolRequest {
  string tenant_id     = 1;
  string user_id       = 2;
  string agent_id      = 3;
  string run_id        = 4;
  string node_id       = 5;
  string tool_name     = 6;    // e.g., "gmail.search"
  google.protobuf.Struct args = 7;
  string idempotency_key = 8;  // derived: hash(run_id||node_id||tool_name||args)
  int32  timeout_ms    = 9;
}

message InvokeToolResponse {
  oneof outcome {
    google.protobuf.Struct result = 1;
    ToolError              error  = 2;
  }
  int32 latency_ms = 3;
  bool  redacted   = 4;
}

message ToolError {
  string code    = 1;          // CONNECTOR_OAUTH_EXPIRED, CONNECTOR_RATE_LIMITED, ...
  string message = 2;
  bool   retryable = 3;
}
```

Idempotency key on `InvokeTool` is hashed from `(run_id, node_id, tool_name, canonical_args)` so a runtime retry never double-sends a Gmail or Slack message. Anchored on BlackBox tool-call idempotency requirement (`blackbox-experience.md` point 17).

### D.3 `AgentRuntime ↔ SkillExecutor`

```proto
service SkillExecutor {
  rpc Execute(ExecuteRequest) returns (stream ExecuteEvent);
}

message ExecuteRequest {
  string skill_id        = 1;
  int32  skill_version   = 2;
  string run_id          = 3;
  string node_id         = 4;
  google.protobuf.Struct input = 5;
  ExecutionCaps caps     = 6;
}

message ExecutionCaps {
  int32 cpu_ms_limit       = 1;   // wall-time bounded
  int32 memory_mb_limit    = 2;
  int32 stdout_kb_limit    = 3;
  bool  allow_network      = 4;   // default false
  repeated string allow_hosts = 5;
  bool  allow_filesystem   = 6;   // default false
  repeated string env_allowlist = 7;
}

message ExecuteEvent {
  oneof kind {
    StdoutChunk stdout = 1;
    StderrChunk stderr = 2;
    ExitResult  exit   = 3;
  }
}

message ExitResult {
  int32  exit_code = 1;
  google.protobuf.Struct result = 2;   // parsed from final stdout JSON line
  int32  cpu_ms_used     = 3;
  int32  memory_mb_peak  = 4;
}
```

Backed by a wasmtime instance per call. Anchored on BlackBox WASM sandbox plane isolating 1M+ daily executions (`resume.txt:49-50`).

### D.4 `AgentRuntime ↔ GuardrailService`

```proto
service GuardrailService {
  rpc CheckInput(CheckInputRequest)         returns (CheckResult);
  rpc CheckOutput(CheckOutputRequest)       returns (CheckResult);
  rpc CheckToolCall(CheckToolCallRequest)   returns (CheckResult);
}

message CheckResult {
  Decision decision = 1;        // ALLOW | REDACT | BLOCK | REQUIRE_HITL
  string   policy_id = 2;
  repeated Finding findings = 3;
  string   redacted_text = 4;   // present if decision == REDACT
}

message Finding {
  string  rule_id   = 1;
  string  category  = 2;        // pii.email, prompt_injection, secrets, profanity, ...
  float   confidence = 3;
  string  span       = 4;       // offending text span (truncated)
}
```

### D.5 `AgentRuntime ↔ ModelGateway`

```proto
service ModelGateway {
  rpc Complete(CompleteRequest)               returns (CompleteResponse);
  rpc CompleteStreaming(CompleteRequest)      returns (stream TokenChunk);
  rpc TokenUsage(TokenUsageRequest)           returns (TokenUsageResponse);
}

message CompleteRequest {
  string tenant_id = 1; string user_id = 2; string agent_id = 3; string run_id = 4;
  string requested_model = 5;                  // "auto" | concrete id
  repeated Message messages = 6;
  repeated ToolSpec tools   = 7;
  CompleteOptions options   = 8;
  RoutingHints     hints    = 9;               // needs_long_context, needs_tools, cheap_ok
}

message CompleteResponse {
  string model_id = 1;
  Message message = 2;
  repeated ToolCall tool_calls = 3;
  Usage usage = 4;
  string finish_reason = 5;
}
```

Routing logic uses `RoutingHints` to pick Claude/GPT/Grok per call. Anchored on BlackBox model router across heterogeneous backends (`resume.txt:55-56`).

### D.6 `AgentRuntime ↔ RAGService`

```proto
service RAGService {
  rpc Query(QueryRequest)            returns (QueryResponse);
  rpc GetChunkById(GetChunkRequest)  returns (Chunk);
}

message QueryRequest {
  string tenant_id = 1; string user_id = 2; string agent_id = 3;
  string corpus_id = 4;          // == rag_source_id
  string query     = 5;
  int32  top_k     = 6;          // default 8
  HybridMode mode  = 7;          // BM25_ONLY | HNSW_ONLY | HYBRID_RRF | HYBRID_RERANK
  repeated string filter_tags = 8;
}

message Chunk {
  string chunk_id    = 1;
  string document_id = 2;
  string corpus_id   = 3;
  string content     = 4;
  google.protobuf.Struct meta = 5;
  double score       = 6;
}
```

### D.7 `IngestionPipeline ↔ MemoryService / RAGService`

```proto
service Ingestion {
  rpc WriteDocument(WriteDocumentRequest)   returns (WriteDocumentResponse);
  rpc DeleteDocument(DeleteDocumentRequest) returns (DeleteDocumentResponse);
  rpc Reindex(ReindexRequest)               returns (stream ReindexProgress);
}

message WriteDocumentRequest {
  string corpus_id   = 1;
  string document_id = 2;
  bytes  raw         = 3;
  string mime_type   = 4;
  google.protobuf.Struct meta = 5;
  ChunkingPolicy chunking = 6;
  string embedder    = 7;        // "EmbedderTextV3"
}
```

---

## E. RAG-as-tool-call contract

The agent does not have a privileged "RAG" path in its prompt. Retrieval is exposed as a regular tool, registered in the capability registry (`05-low-level-design.md` section H) with name `search`:

```json
{
  "name": "search",
  "description": "Search corpus '{corpus_name}' for relevant passages.",
  "parameters": {
    "type": "object",
    "properties": {
      "corpus_id": { "type": "string" },
      "query":     { "type": "string" },
      "top_k":     { "type": "integer", "default": 8 }
    },
    "required": ["corpus_id", "query"]
  }
}
```

When the agent's persona has N attached RAG sources, the registry exposes one bound tool per source (`search_company_docs`, `search_support_tickets`, ...) with `corpus_id` pre-bound. The `ToolCaller` translates the invocation into a `RAGService.Query` gRPC call.

This is the **read path**. The **write path** (ingestion, chunking, embedding with `EmbedderTextV3`, HNSW build) lives entirely in `IngestionPipeline` and is documented in `14-ingestion-pipeline.md`. The two paths share `rag_documents` metadata in Postgres and the pgvector index but never share request flow.

Anchored on BlackBox RAG + VectorDB + HNSW + bm25 cross-encoder stack (`resume.txt:60-61`).

---

## F. Error model

Uniform envelope on every non-2xx response:

```json
{
  "error": {
    "code": "QUOTA_TOKENS_DAILY_EXCEEDED",
    "message": "Daily token budget of 2,000,000 exhausted for user_01HX...",
    "request_id": "req_01HXREQ123",
    "retryable": false,
    "retry_after_ms": null,
    "details": {
      "limit": 2000000,
      "consumed": 2000007,
      "resets_at": "2026-05-28T00:00:00Z"
    }
  }
}
```

Codes by class:

| Class             | Codes                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_*`    | `VALIDATION_PERSONA_TOO_LONG`, `VALIDATION_CONNECTOR_NOT_OWNED`, `VALIDATION_SKILL_MANIFEST_INVALID`, `VALIDATION_RAG_SOURCE_TYPE_UNSUPPORTED`                          |
| `AUTH_*`          | `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_FORBIDDEN`, `AUTH_MFA_REQUIRED`                                                                                      |
| `QUOTA_*`         | `QUOTA_AGENT_LIMIT_EXCEEDED`, `QUOTA_RUNS_PER_MIN_EXCEEDED`, `QUOTA_TOKENS_DAILY_EXCEEDED`, `QUOTA_RAG_SOURCES_EXCEEDED`                                                |
| `MODEL_PROVIDER_*`| `MODEL_PROVIDER_RATE_LIMITED`, `MODEL_PROVIDER_OUTAGE`, `MODEL_PROVIDER_CONTEXT_OVERFLOW`, `MODEL_PROVIDER_TIMEOUT`                                                     |
| `CONNECTOR_*`     | `CONNECTOR_OAUTH_EXPIRED`, `CONNECTOR_RATE_LIMITED`, `CONNECTOR_SCOPE_INSUFFICIENT`, `CONNECTOR_MCP_UNREACHABLE`                                                        |
| `SKILL_*`         | `SKILL_TIMEOUT`, `SKILL_MEMORY_EXCEEDED`, `SKILL_SYNTAX_ERROR`, `SKILL_DISALLOWED_TOOL`, `SKILL_NETWORK_DENIED`                                                         |
| `MEMORY_*`        | `MEMORY_QUOTA_EXCEEDED`, `MEMORY_NOT_FOUND`, `MEMORY_CROSS_TENANT_BLOCKED`                                                                                              |
| `GUARDRAIL_*`     | `GUARDRAIL_INPUT_BLOCKED`, `GUARDRAIL_OUTPUT_REDACTED`, `GUARDRAIL_TOOL_BLOCKED`, `GUARDRAIL_PROMPT_INJECTION`                                                          |
| `INTERNAL_*`      | `INTERNAL_TIMEOUT`, `INTERNAL_UNAVAILABLE`, `INTERNAL_QUEUE_FULL`                                                                                                       |

`retryable: true` codes include `MODEL_PROVIDER_RATE_LIMITED`, `MODEL_PROVIDER_OUTAGE`, `CONNECTOR_RATE_LIMITED`, `INTERNAL_TIMEOUT`, `INTERNAL_UNAVAILABLE`. The client SDK honors `retry_after_ms` with exponential backoff + jitter.

---

## G. Rate limiting and quotas

Anchored on the model router consuming 1B+ tokens/month at BlackBox (`resume.txt:55-56`) — token budgeting is a first-class concern, not an afterthought — and on AutoML's 15M+ jobs/month (`resume.txt:90-92`) where per-user/per-tenant quotas were the difference between a working platform and a fairness disaster.

### Per-user

| Quota                    | Default (free)    | Default (pro)     | Burst              |
| ------------------------ | ----------------- | ----------------- | ------------------ |
| Agents per account       | 10                | 200               | n/a                |
| Runs per minute          | 20                | 200               | 2x for 30s         |
| Tokens per day           | 200,000           | 2,000,000         | hard ceiling       |
| RAG sources              | 5                 | 100               | n/a                |
| Skills uploaded          | 20                | 500               | n/a                |
| MCP endpoints registered | 5                 | 50                | n/a                |

### Per-agent (per run)

| Quota                | Default |
| -------------------- | ------- |
| Max tool calls       | 30      |
| Max nesting depth    | 6       |
| Max wall duration    | 300s    |
| Max output tokens    | 16,384  |
| Max skill invocations| 10      |

### Per-connector

Each connector's outbound RPS is throttled to respect the upstream provider's documented limits, with a per-tenant token bucket living in Redis: `bucket:gmail:{tenant_id}` with refill rate set from the provider's published quota. ConnectorBroker checks the bucket inline; on exhaustion it returns `CONNECTOR_RATE_LIMITED` with `retry_after_ms` set from the bucket's next-refill timestamp.

Enforcement points (in order of cheapest first):

1. **Gateway** — JWT-derived `user_id`, `tenant_id`, plan; checks per-minute and per-day buckets in Redis. Rejects with 429 before any downstream call.
2. **OrchestratorAPI** — applies per-agent budget caps from the run-create payload, intersecting with the user's remaining daily token budget.
3. **AgentRuntime** — checks `max_tool_calls`, `max_nesting_depth`, wall-clock at every node transition. Anchored on `microsoft-experience.md` point 27 — backpressure for AutoML.
4. **ConnectorBroker** — per-connector outbound RPS as above.
5. **ModelGateway** — provider-side rate limit handling (Claude/GPT/Grok) with circuit breakers + fallback routing (`resume.txt:55-56`).

When the global run queue depth exceeds the configured high-water mark (see `05-low-level-design.md` section J), the Gateway returns `INTERNAL_QUEUE_FULL` with `retry_after_ms` set from a backoff schedule, instead of dequeuing into a system that will OOM.
