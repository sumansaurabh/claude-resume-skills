# 13 - Data Model and Storage

A consolidated, copy-paste-able view of every store. Read alongside
`04-low-level-design.md` (which has the surrounding narrative).

## Postgres - `mem_exec` schema

### `exec_run`

```sql
CREATE TABLE exec_run (
  run_id              TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  workflow_id         TEXT NOT NULL,
  parent_run_id       TEXT,
  status              TEXT NOT NULL CHECK (status IN
                       ('queued','running','paused','failed','completed','cancelled')),
  current_checkpoint  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exec_run_tenant_session ON exec_run (tenant_id, session_id, created_at DESC);
CREATE INDEX exec_run_status ON exec_run (status) WHERE status IN ('queued','running','paused');
ALTER TABLE exec_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY exec_run_rls ON exec_run
  USING (tenant_id = current_setting('app.tenant_id', true));
```

### `exec_event` (the load-bearing append-only log)

```sql
CREATE TABLE exec_event (
  event_id           TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES exec_run(run_id),
  tenant_id          TEXT NOT NULL,
  step_id            TEXT NOT NULL,
  parent_checkpoint  TEXT NOT NULL,
  new_checkpoint     TEXT NOT NULL,
  kind               TEXT NOT NULL,
  inputs_hash        TEXT NOT NULL,
  outputs_hash       TEXT,
  payload            JSONB NOT NULL,
  payload_blob_uri   TEXT,
  produced_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, step_id, kind)
) PARTITION BY RANGE (produced_at);

-- monthly partitions, e.g.:
CREATE TABLE exec_event_2026_05 PARTITION OF exec_event
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX exec_event_run_seq ON exec_event (run_id, produced_at);
CREATE INDEX exec_event_tenant_time ON exec_event (tenant_id, produced_at DESC);
ALTER TABLE exec_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY exec_event_rls ON exec_event
  USING (tenant_id = current_setting('app.tenant_id', true));
```

`payload` is bounded at 32 KB. Above that, the payload goes to blob and the
row only carries `payload_blob_uri` + a hash. This is what keeps PG flat at
~70 GB/month at the modeled volume.

### `stm_snapshot` (PG write-through for short-term)

```sql
CREATE TABLE stm_snapshot (
  run_id       TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  checkpoint   TEXT NOT NULL,
  trace        JSONB NOT NULL,
  scratch      JSONB NOT NULL,
  written_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, checkpoint)
);
ALTER TABLE stm_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY stm_snap_rls ON stm_snapshot
  USING (tenant_id = current_setting('app.tenant_id', true));
```

A snapshot is written per checkpoint commit. Recovery reads the latest snapshot
to rehydrate Redis if the live key is gone.

## Postgres - `mem_episodic` schema

### `episodic_event`

```sql
CREATE TABLE episodic_event (
  event_id      TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  seq           BIGINT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('user_message','agent_action','tool_result','user_feedback','system_event')),
  actor         TEXT NOT NULL,
  ref_run_id    TEXT,
  ref_step_id   TEXT,
  payload       JSONB NOT NULL,
  payload_blob_uri TEXT,
  redactions    JSONB,
  pii_vault_ref TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  tombstoned    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (session_id, seq)
);
CREATE INDEX episodic_session_recent ON episodic_event (tenant_id, session_id, seq DESC);
CREATE INDEX episodic_session_kind ON episodic_event (session_id, kind);
ALTER TABLE episodic_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY episodic_event_rls ON episodic_event
  USING (tenant_id = current_setting('app.tenant_id', true));
```

`seq` is server-assigned per `session_id` (atomic counter) so order is
authoritative. `occurred_at` is descriptive only.

### `episodic_summary`

```sql
CREATE TABLE episodic_summary (
  summary_id     TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  covers_from    BIGINT NOT NULL,
  covers_to      BIGINT NOT NULL,
  text           TEXT NOT NULL,
  facts          JSONB,
  embedding_id   TEXT,
  generated_by   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, covers_from, covers_to)
);
CREATE INDEX episodic_summary_session ON episodic_summary (tenant_id, session_id, created_at DESC);
```

## Postgres - `mem_long_term` schema

### `long_term`

```sql
CREATE TABLE long_term (
  scope            TEXT NOT NULL CHECK (scope IN ('user','org','tenant')),
  owner_id         TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            JSONB NOT NULL,
  schema_version   INT NOT NULL,
  source           JSONB NOT NULL,
  ttl_at           TIMESTAMPTZ,
  review_state     TEXT NOT NULL DEFAULT 'approved'
                    CHECK (review_state IN ('approved','pending','rejected','superseded','revoked')),
  version          INT NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, owner_id, key)
);
CREATE INDEX long_term_tenant_owner ON long_term (tenant_id, scope, owner_id);
CREATE INDEX long_term_review ON long_term (review_state) WHERE review_state IN ('pending');
ALTER TABLE long_term ENABLE ROW LEVEL SECURITY;
CREATE POLICY long_term_rls ON long_term
  USING (tenant_id = current_setting('app.tenant_id', true));
```

### `long_term_audit`

```sql
CREATE TABLE long_term_audit (
  audit_id    BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  prev_value  JSONB,
  new_value   JSONB,
  prev_state  TEXT,
  new_state   TEXT,
  actor       TEXT NOT NULL,
  reason      TEXT,
  source      JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX long_term_audit_key ON long_term_audit (tenant_id, scope, owner_id, key, at DESC);
```

### Schema registry (separate config service, snapshotted in PG)

```sql
CREATE TABLE long_term_schema (
  key              TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  json_schema      JSONB NOT NULL,
  pii              BOOLEAN NOT NULL DEFAULT false,
  review_required  BOOLEAN NOT NULL DEFAULT false,
  ttl_days         INT,
  active_from      TIMESTAMPTZ NOT NULL,
  active_to        TIMESTAMPTZ
);
```

## Redis - short-term

| Key | Type | TTL | Notes |
| --- | --- | --- | --- |
| `stm:{tenant}:{run_id}:trace` | LIST | run TTL ≤ 24h | compact JSON items |
| `stm:{tenant}:{run_id}:scratch` | HASH | run TTL | named scratch values |
| `stm:{tenant}:{run_id}:lease` | STRING | lease TTL | `worker_id|expires_at`; SETEX |
| `stm:{tenant}:{run_id}:cursor` | STRING | run TTL | last seen checkpoint |

ACLs per tenant; cluster sharded by `{tenant}|{run_id}` hash tag for
locality.

## Qdrant - vector

Collections:

- `vec_t_<tenant_short_id>_main` (one per tenant for high-volume tenants)
- `vec_shared_low_volume` (with payload filter on `tenant_id` for the long
  tail; trades hard-isolation for cost)

Index config:

```yaml
hnsw:
  m: 16
  ef_construct: 128
  ef_search: 96            # tunable per query
  full_scan_threshold: 10000
optimizers:
  default_segment_number: 4
quantization:
  scalar:
    type: int8
    quantile: 0.99
    always_ram: true
```

Payload schema:

```json
{
  "tenant_id":   "string",
  "scope":       "string",      // session:<id> | long_term:<scope>:<owner> | doc:<scope>:<owner>
  "source_store": "episodic | long_term | doc",
  "source_ref":   "string",     // pointer back to source row
  "content_hash": "sha256:...",
  "created_at":   "rfc3339",
  "model":        "string",
  "model_version":"string",
  "lang":         "string",
  "tags":         ["string"]
}
```

bm25 sidecar (Tantivy): one index per Qdrant collection, keyed on `content_hash`.

## Object Storage Layout

```
runs/{tenant_id}/{run_id}/events/{event_id}/payload.json     # large step payloads
runs/{tenant_id}/{run_id}/events/{event_id}/model_io.json    # full model in/out
sessions/{tenant_id}/{session_id}/blobs/{event_id}.bin       # large episodic
audit/{tenant_id}/yyyy/mm/dd/audit-<seq>.jsonl               # WORM bucket
archives/exec_event/{yyyy_mm}/parquet/...                    # cold archive
pii/{tenant_id}/{vault_ref}.bin                              # PII vault (separate KMS DEK)
```

Bucket policies enforce per-tenant prefixes; lifecycle policies move hot →
cold → glacier per tenant retention class.

## OTel Span Schema (memory-plane subset)

```
trace_id, span_id, parent_span_id, name="mem.<tier>.<op>",
attributes:
  mem.tier, mem.op, mem.tenant_id, mem.org_id, mem.user_id,
  mem.session_id, mem.run_id, mem.step_id, mem.checkpoint_version,
  mem.bytes, mem.items_returned, mem.cache_hit,
  mem.policy_decision, mem.degraded, mem.error_class,
  http.status_code, db.system="postgresql"|"redis"|"qdrant",
  net.peer.name, net.peer.port
events:
  mem.policy.decision (decision_id, rule_id),
  mem.degraded.skip   (tier, reason),
  mem.replay.diff     (left_hash, right_hash)
```

These spans flow into the platform's OTel → Clickhouse pipeline (50M
spans/day per resume).

## Retention Matrix (default policy)

| Store | Tenant tier "Standard" | Tenant tier "Enterprise" |
| --- | --- | --- |
| `exec_event` (hot PG) | 30 days | 90 days |
| `exec_event` (Parquet cold) | 1 year | 7 years |
| `episodic_event` | 90 days | 1 year (configurable) |
| `episodic_summary` | 1 year | 7 years |
| `long_term` | indefinite (TTL per key) | indefinite (TTL per key) |
| `vector` | mirrors source | mirrors source |
| Audit | 7 years | 7 years |
| Spans (Clickhouse) | 30 days hot, 90 days cold | 90 days hot, 1 year cold |

## Anchors

- Vector / HNSW / bm25 / cross-encoder shape - `resume.txt` technologies line
  on BlackBox.
- Append-only event log + checkpoints + replay - `resume.txt` BlackBox
  bullet 3 + bullet 5; `blackbox-experience.md` #12, #13, #20.
- Multi-tenant + SOC-2 retention obligations - `blackbox-experience.md` #5.
