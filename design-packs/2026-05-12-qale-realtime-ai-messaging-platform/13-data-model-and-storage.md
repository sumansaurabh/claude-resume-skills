# 13 — Data Model and Storage

The persistent surface of Qale: what we store, where, why, and how it survives growth, deletion, and restore. Anchors from `00-question-and-context.md`.

## 1. Storage inventory

| Store | Purpose | Sizing at 1M users | RPO | RTO | Anchor |
| --- | --- | --- | --- | --- | --- |
| Postgres (data plane, sharded by `workspaceId`) | Messages, threads, members, AI runs, read receipts | ~2.5 TB hot | 5 min | 30 min | A-BB1 (Postgres + RLS at scale) |
| Postgres (control plane) | Workspaces, billing, policy, audit | ~50 GB | 5 min | 30 min | A-MS3 |
| Redis (cluster) | Presence, delivery cursors, rate-limit counters, token budget atomic counters | ~80 GB | n/a (rebuildable) | minutes | — |
| Kafka | Event backbone (`message.events`, `policy.changes`, `audit.events`, AI streams) | 7-day retention; ~6 TB | minutes | minutes | A-BB3 |
| S3 (attachments + cold tier) | Files, exports, audit log archives, message Parquet >90d | grows linearly; $$ predictable | 0 (versioned) | minutes | A-BB1 |
| Qdrant | Vector index (thread memory, semantic search) | ~600 GB at 1M users | 1h (rebuildable) | 4h | A-BB2 |
| OpenSearch | Lexical + hybrid search index | ~400 GB | 1h (rebuildable) | 2h | — |
| ClickHouse | Telemetry, LLM spans, replay logs | ~6 TB rolling | 1h | 4h | A-BB5 |
| Object store (model artifacts, embeddings cache) | Embedding cache, prompt templates | ~50 GB | 24h | 4h | — |

## 2. Postgres DDL — core tables

All data-plane tables enforce **row-level security keyed by `workspace_id`** (anchor A-BB1). Every query carries `SET app.workspace_id = $ws` set by the gateway after authn.

### 2.1 `workspaces` (control DB)

```sql
CREATE TABLE workspaces (
  id              UUID PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  plan            TEXT NOT NULL,            -- free | pro | enterprise
  region          TEXT NOT NULL,            -- us-east-1 | eu-west-1 | ap-south-1
  status          TEXT NOT NULL DEFAULT 'active',  -- active | tombstoned | purged
  tombstoned_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON workspaces (region, status);
CREATE INDEX ON workspaces (tombstoned_at) WHERE status='tombstoned';
```

### 2.2 `users`, `memberships` (control DB)

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,               -- owner | admin | member | guest
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON memberships (user_id);
```

### 2.3 `threads` (data plane, sharded)

```sql
CREATE TABLE threads (
  id              UUID NOT NULL,
  workspace_id    UUID NOT NULL,
  kind            TEXT NOT NULL,             -- dm | group | channel | ai
  title           TEXT,
  created_by      UUID NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | archived | deleted
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX ON threads (workspace_id, last_message_at DESC) WHERE status='active';
CREATE INDEX ON threads (workspace_id, kind, status);

ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_ws_iso ON threads
  USING (workspace_id = current_setting('app.workspace_id')::uuid);
```

### 2.4 `messages` (hot path; partitioned)

```sql
CREATE TABLE messages (
  id              UUID NOT NULL,
  workspace_id    UUID NOT NULL,
  thread_id       UUID NOT NULL,
  author_id       UUID NOT NULL,
  body            TEXT,                      -- nullable for tombstone
  attachments     JSONB,                     -- [{key, mime, size}]
  parent_id       UUID,                      -- for replies/threads
  status          TEXT NOT NULL DEFAULT 'durable',  -- durable | failed | deleted
  version         INT NOT NULL DEFAULT 1,
  client_msg_id   TEXT NOT NULL,             -- idempotency key from client
  created_at      TIMESTAMPTZ NOT NULL,
  edited_at       TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id)
) PARTITION BY RANGE (created_at);

-- monthly partitions
CREATE TABLE messages_2026_05 PARTITION OF messages
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX ON messages (workspace_id, thread_id, created_at DESC) WHERE status='durable';
CREATE UNIQUE INDEX ON messages (workspace_id, author_id, client_msg_id);  -- idempotency
CREATE INDEX ON messages (workspace_id, parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY msg_ws_iso ON messages
  USING (workspace_id = current_setting('app.workspace_id')::uuid);
```

**Partition strategy:** monthly partitions; partitions older than 90 days flushed to S3 Parquet (cold tier) and detached, queryable via Trino/Athena from the admin console for compliance reads.

### 2.5 `read_receipts` (write-amp aware)

```sql
CREATE TABLE read_receipts (
  workspace_id  UUID NOT NULL,
  thread_id     UUID NOT NULL,
  user_id       UUID NOT NULL,
  last_read_id  UUID NOT NULL,               -- last message read in thread
  updated_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, thread_id, user_id)
);
```

Writes batched through Redis (per-(user, thread) coalescing every 1s); flushed to Postgres in bulk to cut write amplification ~10×.

### 2.6 `outbox` (transactional outbox to Kafka)

```sql
CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL,
  topic           TEXT NOT NULL,
  partition_key   TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);
CREATE INDEX ON outbox (published_at NULLS FIRST, id) WHERE published_at IS NULL;
```

Outbox relay tails this with a logical replication slot or a polling worker; publishes to Kafka, marks `published_at`. Guarantees at-least-once with no double-write.

### 2.7 `ai_runs` and `ai_run_steps` (durable workflow state)

```sql
CREATE TABLE ai_runs (
  id              UUID NOT NULL,
  workspace_id    UUID NOT NULL,
  thread_id       UUID,
  user_id         UUID NOT NULL,
  status          TEXT NOT NULL,             -- queued | routing | executing | completed | failed | cancelled | budget_exceeded
  prompt_hash     TEXT NOT NULL,
  routed_model    TEXT,
  tokens_in       INT,
  tokens_out      INT,
  cost_usd        NUMERIC(10,4),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX ON ai_runs (workspace_id, user_id, started_at DESC);
CREATE INDEX ON ai_runs (status, started_at) WHERE status IN ('queued','routing','executing');

CREATE TABLE ai_run_steps (
  workspace_id  UUID NOT NULL,
  run_id        UUID NOT NULL,
  node_id       TEXT NOT NULL,
  attempt_id    INT  NOT NULL,
  status        TEXT NOT NULL,               -- pending|running|succeeded|failed|retrying|compensating|waiting
  input_hash    TEXT,
  output_hash   TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  metadata      JSONB,                       -- tool name, provider, retry reason
  PRIMARY KEY (workspace_id, run_id, node_id, attempt_id)
);
```

`(run_id, node_id, attempt_id)` is the **idempotency key** for tool dispatches (anchor A-BB3).

### 2.8 `audit_log` (append-only, dual-written to S3 immutable)

```sql
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL,
  actor_id        UUID,
  actor_type      TEXT NOT NULL,             -- user | service | ai
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  metadata        JSONB,
  ip              INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
CREATE INDEX ON audit_log (workspace_id, created_at DESC);
CREATE INDEX ON audit_log (workspace_id, actor_id, created_at DESC);
```

Mirrored daily to S3 with Object Lock (compliance-mode WORM, 7-year retention) for SOC-2 evidence.

## 3. S3 layout (cold tier and attachments)

```
s3://qale-prod-{region}/
  workspaces/{wsId}/attachments/{yyyy}/{mm}/{sha256}.{ext}
  workspaces/{wsId}/exports/{exportId}.zip
  workspaces/{wsId}/cold/messages/{yyyy}/{mm}/part-*.parquet
  audit/{yyyy}/{mm}/{dd}/audit-*.parquet           (Object Lock)
  models/embeddings/{model}/{sha256}.bin           (cache)
```

Per-workspace KMS key on attachments + cold tier (anchor: tenant isolation invariant). Bucket policies block cross-tenant reads at the IAM layer too — defense in depth.

## 4. Redis usage

| Key pattern | TTL | Purpose |
| --- | --- | --- |
| `presence:{wsId}` (sorted set; user → last_seen_ms) | 90s sliding | Presence aggregation |
| `cursor:{wsId}:{userId}:{threadId}` | 24h sliding | Per-recipient delivery cursor |
| `budget:{wsId}:{day}` (atomic INCR) | 48h | Token / cost budget enforcement |
| `rate:{userId}:{verb}:{minute}` | 90s | Per-user rate limit |
| `gateway:{userId}` (set of pod IDs) | 30s sliding | Sticky routing fallback |
| `dedup:{client_msg_id}` | 10 min | Cross-pod idempotency hint (Postgres still authoritative) |

Redis is **rebuildable from Postgres** for everything except presence — losing Redis costs 60s of stale presence and a brief recompute storm, not data.

## 5. Qdrant — vector schema

Per-workspace collection: `ws_{wsId}_threads`. Avoids cross-tenant noisy-neighbor at the index level (anchor A-BB1).

```
collection: ws_{wsId}_threads
vector:     dim=1024, cosine
payload:
  thread_id: uuid
  message_id: uuid
  author_id: uuid
  created_at: int64 (epoch ms)
  segment: text (chunk)
  tokens: int
  acl_tag: text  -- redundant in-collection ACL check
```

Sharding: ~50 collections per Qdrant node; once a tenant exceeds 5M vectors, promote to a dedicated node (anchor A-BB1 — tenant-aware sharding).

## 6. OpenSearch — hybrid search

Index per workspace: `ws-{wsId}-messages`. Doc:

```json
{
  "message_id": "...",
  "thread_id": "...",
  "author_id": "...",
  "body": "...",
  "created_at": 1747000000000,
  "kind": "message|file|link",
  "acl": ["userId1","userId2"]
}
```

Hybrid retrieval: BM25 from OpenSearch + cosine top-k from Qdrant → reranker (cross-encoder, batched) → top-N for the AI agent.

## 7. ClickHouse — telemetry tier

Anchor A-BB5 (telemetry mesh). Schemas:

```sql
CREATE TABLE otel_spans (
  trace_id        FixedString(32),
  span_id         FixedString(16),
  parent_span_id  FixedString(16),
  service         LowCardinality(String),
  name            LowCardinality(String),
  workspace_id    UUID,
  user_id         Nullable(UUID),
  start_ns        UInt64,
  duration_ns     UInt64,
  status_code     LowCardinality(String),
  attrs           Map(LowCardinality(String), String)
) ENGINE = MergeTree
  PARTITION BY toYYYYMMDD(toDateTime64(start_ns/1e9, 3))
  ORDER BY (workspace_id, service, start_ns)
  TTL toDateTime64(start_ns/1e9, 3) + INTERVAL 14 DAY DELETE;

CREATE TABLE llm_spans (
  trace_id        FixedString(32),
  run_id          UUID,
  workspace_id    UUID,
  user_id         UUID,
  provider        LowCardinality(String),
  model           LowCardinality(String),
  prompt_hash     FixedString(64),
  prompt_tokens   UInt32,
  completion_tokens UInt32,
  cost_usd        Decimal(10,6),
  latency_ms      UInt32,
  finish_reason   LowCardinality(String),
  tool_calls      UInt8,
  ts              DateTime64(3)
) ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (workspace_id, model, ts)
  TTL ts + INTERVAL 90 DAY DELETE;
```

Replay corpus retained 90 days (anchor A-BB5 — deterministic replay of agent runs).

## 8. Sharding and growth path

| Stage | Postgres topology | Trigger to next |
| --- | --- | --- |
| Alpha (≤ 50K users) | Single primary + replica | > 60% CPU sustained |
| Beta (≤ 250K users) | Vertical scale (r6g.4xl) + 2 replicas | Top-10 workspace > 30% of WAL |
| Public launch (≤ 500K users) | Citus on `workspace_id` (4 shards) | > 60% per-shard CPU |
| Scale (1M+) | Citus 16+ shards; biggest tenants on dedicated shards | > 1B messages/quarter |

**Why Citus over Vitess:** Postgres is already the source of truth and we use Postgres-only features (RLS, JSONB, partial indexes). Citus extends Postgres in place; Vitess would force MySQL semantics. Tradeoff TR-7.

Re-sharding plan: dual-write + backfill + cut over (anchor A-BB1 — done at BlackBox for tenant-aware sharding).

## 9. RPO / RTO and restore drills

| Class | RPO | RTO | Mechanism |
| --- | --- | --- | --- |
| Postgres data plane | 5 min | 30 min | PITR (5-min WAL ship to S3) + per-shard cross-AZ replicas |
| Postgres control plane | 5 min | 30 min | Same; smaller blast radius |
| Redis | n/a (rebuildable) | 5 min | Restart + repopulate from Postgres |
| Kafka | 5 min | 15 min | 3× replication + tiered storage |
| S3 attachments | 0 | minutes | Versioning + cross-region replication for paid tiers |
| Qdrant | 1h (re-index) | 4h | Snapshot every 6h; otherwise rebuild from messages |
| OpenSearch | 1h | 2h | Snapshot to S3 every 6h |
| ClickHouse | 1h | 4h | Replicated-MergeTree, 2 replicas |

**Quarterly restore drill** required (anchor A-MS1 — Microsoft compliance posture): pick a random shard, restore to a sandbox cluster, replay 1h of Kafka, verify message counts match.

## 10. Workspace hard-delete cascade (anchor A-BB1)

Workspace deletion is a control-plane intent that fans out across every store. Sequence:

1. Control plane writes `workspaces.status='tombstoned'`, `tombstoned_at = now()`, publishes `workspace.tombstone {wsId}` on `policy.changes`.
2. **T+0:** gateway invalidates sessions, refuses new connections, evicts cached policy. User-visible delete is instant.
3. **T+0..1h:** delete workers (one per store) consume the topic and execute:

| Store | Action |
| --- | --- |
| Postgres data plane | `DELETE FROM messages/threads/read_receipts WHERE workspace_id = $ws`; relies on partition-aware bulk deletes |
| Postgres control plane | `DELETE FROM memberships WHERE workspace_id = $ws` |
| Redis | `SCAN MATCH *:{wsId}:* | UNLINK` |
| S3 attachments | Bulk delete prefix `workspaces/{wsId}/` |
| S3 cold tier | Same |
| Qdrant | `DELETE collection ws_{wsId}_threads` |
| OpenSearch | `DELETE index ws-{wsId}-messages` |
| ClickHouse | `ALTER TABLE ... DELETE WHERE workspace_id = $ws` (lazy) |
| Embeddings cache | Drop by prefix |
| Audit log | **Retained** in S3 Object Lock per compliance — keyed but unlinkable from live data |

4. **T+24h:** verifier job runs queries against each store; if any returns rows for that `workspace_id`, page on-call and re-execute the failed worker.
5. **T+30d:** `workspaces.status='purged'`; any leftover audit references hashed.

Same shape as BlackBox tenant-aware Postgres + RLS lifecycle (anchor A-BB1) — the lesson there was *the cascade only works if every store has a delete worker that watches the same topic; one-off scripts rot*.

## 11. PII inventory

| PII class | Stored where | Encryption | Retention |
| --- | --- | --- | --- |
| Email, name | Control DB `users` | At-rest (KMS) | Until account deletion + 30d |
| Message bodies | Data plane `messages`, S3 cold | At-rest, per-WS KMS for cold tier | Workspace-controlled (default ∞; configurable retention policy) |
| Attachments | S3 | At-rest, per-WS KMS | Same as messages |
| AI prompts/responses | `ai_runs`, ClickHouse `llm_spans` | At-rest | 90 days for spans; runs follow message retention |
| Read receipts | `read_receipts` | At-rest | Same as messages |
| IP addresses | `audit_log` | At-rest | 90 days, then truncated to /24 |
| Push tokens | Notification store | At-rest | Until device unregister |

Right-to-erasure: per-user delete cascades across data plane; AI prompts containing the user's content are scrubbed via a tombstone (text replaced with `[redacted]`, hash retained for replay integrity).

## 12. Schema migration discipline

Three rules (anchor A-MS3):

1. **Backwards-compatible on the way out.** Every release must be safe to deploy alongside the previous version (no destructive column drops in the same release as code that stops writing them).
2. **Online migrations.** No long table locks. Use Liquibase/Flyway with `CREATE INDEX CONCURRENTLY`, batched backfills (10k-row chunks), and `pg_repack` for table rewrites.
3. **Migration runbooks before merge.** Each migration PR includes: forward path, rollback path, expected duration on prod size, and how to verify success. Reviewed by data-plane oncall.
