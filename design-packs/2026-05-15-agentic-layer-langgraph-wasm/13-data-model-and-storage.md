# 13 - Data Model and Storage

The agentic layer has five data surfaces:

1. **Run + checkpoint state** (Postgres + S3 blobs)
2. **Tool / model call audit log** (Postgres → ClickHouse for analytics)
3. **Memory** (Postgres for working memory, Qdrant for semantic, with
   namespace-per-tenant)
4. **Artifacts** (S3 with content-addressed naming)
5. **Telemetry spans** (ClickHouse via OTel)

This file pins the schemas and the retention model.

## Postgres schemas

### `tenants`, `projects`, `users`

Standard SaaS multi-tenant primitives. Row-level security enabled on all
agent-owned tables based on `tenant_id`.

### `runs`

```sql
CREATE TABLE runs (
  run_id              TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  archetype           TEXT NOT NULL,
  prompt_hash         BYTEA NOT NULL,
  prompt_blob_key     TEXT NOT NULL,
  status              TEXT NOT NULL,
  current_node        TEXT,
  last_checkpoint_id  TEXT,
  tokens_used         BIGINT DEFAULT 0,
  cost_micros         BIGINT DEFAULT 0,
  budget              JSONB NOT NULL,
  error               JSONB,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  finished_at         TIMESTAMPTZ
);
CREATE INDEX runs_tenant_created ON runs (tenant_id, created_at DESC);
CREATE INDEX runs_status_updated ON runs (status, updated_at) WHERE status IN ('queued','running','paused','awaiting_approval');
```

The full prompt goes to a blob (`prompt_blob_key`); only the hash sits in
Postgres for dedup and lookup.

### `checkpoints`

```sql
CREATE TABLE checkpoints (
  run_id        TEXT NOT NULL,
  seq           INT  NOT NULL,
  parent_seq    INT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  node_after    TEXT NOT NULL,
  state_jsonb   JSONB NOT NULL,
  blob_keys     TEXT[] DEFAULT '{}',
  size_bytes    INT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX checkpoints_run_recent ON checkpoints (run_id, seq DESC);
```

`state_jsonb` contains the small typed `RunState`. Any field over 10 KB
(typically `messages`, `plan.full_text`, large observations) is replaced
with `{"_blob_key": "<hash>"}` and the blob lives in S3.

Retention: full retention for 30 days; then state is summarized into a
single "final state" checkpoint and the intermediate rows are deleted,
freeing Postgres while keeping replay possible for in-window incidents.

### `model_calls`

```sql
CREATE TABLE model_calls (
  call_id        TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  node_name      TEXT NOT NULL,
  tenant_id      TEXT NOT NULL,
  prompt_hash    BYTEA NOT NULL,
  chosen_model   TEXT NOT NULL,
  candidates     TEXT[] NOT NULL,
  routing_reason TEXT,
  degraded       BOOLEAN DEFAULT false,
  tokens_in      INT,
  tokens_out     INT,
  cost_micros    BIGINT,
  duration_ms    INT,
  ttfb_ms        INT,
  status         TEXT NOT NULL,
  error          JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX model_calls_run ON model_calls (run_id, created_at);
CREATE INDEX model_calls_prompt_hash ON model_calls (prompt_hash);
```

The `prompt_hash` index is what enables observation caching at replay
time. Tenant-scoped cost reports query this table.

### `tool_calls`

```sql
CREATE TABLE tool_calls (
  envelope_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL,
  node_name            TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  tool                 TEXT NOT NULL,
  tool_version         TEXT NOT NULL,
  args_hash            BYTEA NOT NULL,
  args_blob_key        TEXT,
  observation_blob_key TEXT,
  side_effect_class    TEXT NOT NULL,
  cached               BOOLEAN DEFAULT false,
  exit_code            INT,
  duration_ms          INT,
  cpu_ms_used          INT,
  memory_mb_peak       INT,
  stdout_kb            INT,
  egress_kb            INT,
  created_at           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX tool_calls_run ON tool_calls (run_id, created_at);
CREATE INDEX tool_calls_args_hash ON tool_calls (tool, args_hash);
```

`envelope_id` is the idempotency key. A duplicate insert with the same
ID is the contract that "we already executed this" - the broker's
idempotency table is this table with `ON CONFLICT (envelope_id) DO NOTHING`.

### `policy_decisions`

```sql
CREATE TABLE policy_decisions (
  decision_id     TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  node_name       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  tool            TEXT NOT NULL,
  side_effect     TEXT NOT NULL,
  args_hash       BYTEA NOT NULL,
  allowed         BOOLEAN NOT NULL,
  requires_human  BOOLEAN NOT NULL,
  reason          TEXT NOT NULL,
  approver_id     TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

This table feeds the SOC-2 evidence export - every policy gate decision
is here, append-only, with the approver if any.

### `working_memory`

```sql
CREATE TABLE working_memory (
  memory_id    TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  scope        TEXT NOT NULL,         -- 'project' | 'run' | 'session'
  scope_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- 'decision' | 'preference' | 'fact'
  content      TEXT NOT NULL,
  embedding_id TEXT,                  -- pointer into Qdrant
  created_at   TIMESTAMPTZ DEFAULT now(),
  expires_at   TIMESTAMPTZ
);
CREATE INDEX wm_lookup ON working_memory (tenant_id, project_id, scope, scope_id);
```

Working memory has hard TTLs by scope: `run` ⇒ 7 days, `session` ⇒ 24h,
`project` ⇒ explicit user-managed.

## Memory tiering

| Tier | Where | Latency | Use case |
| - | - | - | - |
| Conversation buffer | In `RunState.messages` in Postgres | ms | The current ReAct loop |
| Working memory | `working_memory` rows | tens of ms | Decisions made during the run |
| Episodic memory | Compressed run summaries in Postgres + blob | hundreds of ms | "What did we do last time in this project?" |
| Semantic memory | Qdrant vector store per `tenant+project` | hundreds of ms | "Have I solved this kind of problem before?" |
| Long-term tenant memory | Compressed quarterly summaries, opt-in | seconds | Cross-project patterns |

Cross-tenant isolation is structurally enforced at every tier - see
`06-security-and-isolation.md` for the controls.

## S3 / object storage layout

```
blackbox-agent-blobs/
  prompts/sha256/<aa>/<bb>/<full_hash>          # user prompts, model prompts
  observations/sha256/<aa>/<bb>/<full_hash>     # tool observations over 10 KB
  state/run_<run_id>/seq_<seq>.json.zst         # checkpoint blobs over threshold
  artifacts/run_<run_id>/<artifact_id>.tar.zst  # final signed deliverables
  previews/run_<run_id>/<file>                  # screenshots, preview snapshots
```

Content-addressed naming for prompts / observations means duplicates are
deduped automatically. A Slack-clone run with 60 sandbox calls might
generate ~12 MB of observation data, but ~70% of it gets deduped across
runs.

Lifecycle: prompts + observations → 90 days standard, then Glacier.
Artifacts → 30 days standard, then user-paid extended retention.
Checkpoint state blobs → 30 days, then deleted (replay window).

## ClickHouse - telemetry mesh

The OTel collector ships spans to ClickHouse with a schema tuned for
LLM workloads:

```sql
CREATE TABLE agent_spans (
  trace_id        FixedString(32),
  span_id         FixedString(16),
  parent_span_id  FixedString(16),
  run_id          String,
  tenant_id       String,
  node_name       String,
  span_kind       LowCardinality(String),     -- 'graph' | 'model' | 'tool' | 'http'
  start_ns        UInt64,
  duration_ns     UInt64,
  status          LowCardinality(String),
  attrs           Map(LowCardinality(String), String),
  prompt_hash     Nullable(String),
  args_hash       Nullable(String),
  model           LowCardinality(Nullable(String)),
  tool            LowCardinality(Nullable(String)),
  tokens_in       Nullable(UInt32),
  tokens_out      Nullable(UInt32),
  cost_micros     Nullable(UInt64)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(toDateTime64(start_ns/1e9, 0))
ORDER BY (tenant_id, run_id, start_ns);
```

Hot data (last 7 days): full retention with all attributes.
Warm data (8–90 days): drop non-numeric attribute bodies; keep
`prompt_hash`/`args_hash` so dedup-based replay still works.
Cold data (90 days–2 years): aggregated daily rollups only.

At 50M spans/day and ~500 bytes/span net of attribute pruning, this is
~25 GB/day raw, ~2.5 TB/month including hot copy and replicas - exactly
matching the resume claim.

## Idempotency tables

`tool_calls.envelope_id` and `model_calls.call_id` are the idempotency
keys. The broker has an in-memory LRU (1M entries) backed by these
Postgres tables - a duplicate envelope misses the LRU but hits the table.

## Cleanup and TTLs (summary)

| Data | TTL | Cleanup mechanism |
| - | - | - |
| Workspace files | Run + 5 min | Sandbox plane GC |
| Working memory (run scope) | 7 days | Cron + index TTL |
| Checkpoints (intermediate) | 30 days | Cron compaction to final-state checkpoint |
| Prompt + observation blobs | 90 days | S3 lifecycle policy |
| Artifacts | 30 days (default) | S3 lifecycle, user-extendable |
| Spans (hot) | 7 days full attrs | ClickHouse TTL |
| Spans (warm) | 90 days numeric + hashes | ClickHouse TTL move |
| Policy decisions | 7 years (SOC-2) | Archived to evidence bucket monthly |

The 7-year retention on policy decisions is the *only* infinite-feeling
retention; everything else has a clear forget-by-date.

## Why this data model holds up

- **Hash-keyed everywhere.** Prompts, args, observations are content-
  addressed, which is what unlocks both dedup and replay.
- **Side-effect classification is in the row.** Audit queries don't need
  to join tables to know "what destructive tool calls happened last week."
- **Tenant ID is on every row.** No "implicit tenant via project_id"
  ambiguity at query time. Row-level security is a true control, not a
  comment in code.
- **Big things are blobs.** Postgres rows stay narrow; large free-form
  data lives where free-form data should live.
- **Telemetry is the lakehouse.** ClickHouse holds the analytics shape;
  Postgres holds the source-of-truth shape. They don't fight.
