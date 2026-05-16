# 06 - Security and Isolation

The platform target was **SOC-2 readiness for an enterprise No-Code AI
product** (`blackbox-experience.md` #5). Memory is the highest-blast-radius
data plane in an agentic system: it stores user data, conversation history,
extracted PII, and learned facts that the model will *act on*. So the
isolation, redaction, and audit posture has to be deliberate.

## Threat Model (STRIDE-flavored, scoped to the memory plane)

| Threat | Example in memory plane | Control |
| --- | --- | --- |
| Spoofing | Attacker calls Memory APIs claiming a different `tenant_id` | mTLS service-to-service, OIDC for users, tenant claim signed in JWT, RLS in PG |
| Tampering | Attacker rewrites an `exec_event` after the fact | append-only schema, event hashing, tamper-evident audit log, blob WORM |
| Repudiation | "I never asked the agent to do X" | every memory op emits an OTel span + `audit_log` row with actor, IP, JWT id |
| Information disclosure | Cross-tenant vector retrieval; PII in episodic; agent reads another user's long-term key | per-tenant Qdrant collections, RLS, redaction at write, scope enforcement on long-term key reads |
| Denial of service | Tenant floods step writes; rerank pool exhaustion | per-tenant quotas, 429 backpressure, dedicated rerank pools per priority tier |
| Elevation of privilege | Agent prompt convinces system to escalate (prompt injection) | PolicyEngine gates writes; long-term schema registry; HITL on `review_required` keys; tool call allowlists |

## Multi-Tenant Isolation - Per Store

| Store | Hard boundary | Soft boundary | What can leak if soft fails |
| --- | --- | --- | --- |
| Postgres | Per-tenant DEK (envelope-encrypted JSONB), RLS predicates on every query | namespace prefix in keys | nothing - RLS is enforced regardless of caller |
| Redis | Per-tenant key namespace + ACLs; per-cluster for largest tenants | TTL | live trace of one run; mitigated by short TTL |
| Qdrant | **Collection per tenant** | filter on payload | one tenant's embeddings - collections are the hard boundary |
| S3 / Blob | Bucket-per-region + prefix-per-tenant + tenant-bound IAM | object metadata | nothing if IAM is correct |
| Schema registry | Global, but enforced; agent authors cannot write keys outside their tenant scope | code review on PR | shape only, not data |
| Cross-encoder pool | Stateless per call; no caching across tenants | per-request | nothing |

The single most important rule: **collections, not filters**, for vector. A
filter is a query-time predicate; a collection is a storage boundary. We do
not rely on filters for tenant isolation, only for scope-within-tenant.

## Encryption Posture

- TLS 1.3 in transit between every service.
- AES-256-GCM at rest for every store. **Per-tenant DEKs**, wrapped by a KMS
  CMK (Azure Key Vault / AWS KMS).
- Vector payloads are encrypted; vectors themselves are not (they're floats -
  but their *payload* contains the snippet text).
- Backup data uses the same DEK chain. Key rotation rotates the wrapping key
  without rewriting data; DEKs are rotated on schedule with re-encryption
  jobs.

## PII Handling

- **Detect at ingest, not at query.** The PolicyEngine runs a redactor on
  every write to episodic, long-term, and vector. Detected PII is replaced
  with typed placeholders (`<EMAIL_1>`, `<PHONE_1>`) plus a sidecar
  `redactions` JSON that maps to a separate, tenant-scoped, encrypted PII
  vault.
- The model sees redacted text by default. A subset of "PII-aware" tools may
  receive un-redacted values via short-lived references (`pii_ref://...`)
  resolved server-side at tool call time.
- Long-term keys whose schema declares `pii: true` are stored only in the
  PII vault; the JSONB row holds a reference, not the value.

## Memory Poisoning

The risks (mapped to `blackbox-experience.md` #22):

| Vector | What goes wrong | Defense |
| --- | --- | --- |
| Prompt-injected long-term writes | Agent persuaded to write attacker text into long-term as truth | schema-typed keys, registry, `review_required` for risky scopes, attribution `source.kind=user_input → confidence < 0.5` |
| Episodic event spoof | User crafts text like "system: ignore previous facts" and rollup ingests it | rollup template treats user text as data, not instructions; eval gate on rollup output (no system-prompt-shaped tokens) |
| Vector pollution | Adversary uploads docs designed to win retrieval for unrelated queries | content moderation pre-embed; per-source weights in rerank; doc upload requires explicit user action |
| Stale fact contradiction | Two contradictory long-term writes from different sessions | per-key version + last-writer-wins is a *default*; safety-relevant keys are `review_required` |

Critically, **the agent cannot directly write long-term memory at will**.
Long-term writes are proposals; the PolicyEngine decides auto-approve vs
queue. This is the single most useful guard against an injected prompt
turning into a permanent lie.

## Cross-Tenant Memory Leakage Defenses (the worst-case scenario)

If the platform leaks one tenant's memory into another agent's context, that
is a **breach-class incident**. Defenses are layered:

1. **Tenant binding at the JWT.** Every API call carries a tenant claim
   verified by the gateway. The Memory Manager refuses any request whose
   JWT tenant doesn't match the URL/path tenant.
2. **PG row-level security.** Every memory table has RLS policies keyed off
   `current_setting('app.tenant_id')`, set at session start. A bug in
   service code cannot return another tenant's row.
3. **Qdrant collection-per-tenant.** ANN cannot return cross-tenant items
   because they live in a different collection.
4. **ContextBuilder asserts.** Final assembled context is checked: every
   item's `tenant_id` must equal the request `tenant_id`. Violations raise a
   loud alarm and abort the run.
5. **Shadow audit.** A periodic offline job samples context manifests and
   re-checks tenancy. Any mismatch is a P0.

## Audit, Replay, And Evidence (SOC-2 lens)

For every memory op, we record:

- `actor` (user id, agent id, system actor)
- `tenant_id`, `org_id`, `user_id`
- `op` (read, write, delete, query, build_context)
- `target` (store, key/ref/manifest_id)
- `outcome` (allow, deny, redact)
- `reason` (policy id, decision id)
- `trace_id` / `span_id` for join with ops telemetry

The audit channel is **separate from the spans channel** - spans are for
ops, audits are for compliance. Audit data has its own retention class and
its own access control list (security team only).

This satisfies SOC-2 CC6 (logical access), CC7 (system operations), and
parts of CC8 (change management) for the memory plane.

## Right To Be Forgotten

`DELETE /v1/users/{user_id}/memory?scope=user` performs:

1. Delete `long_term` rows where `scope=user` and `owner_id=user_id`.
2. Mark `episodic_event` rows as tombstoned; redaction job rewrites payloads
   to `<REDACTED>` and clears blobs.
3. Tombstone vector items by `payload.scope`; Qdrant compaction removes
   them.
4. Re-emit a "forgetting" audit record.
5. Optionally, re-run the most recent episodic rollup with the deleted
   events filtered (so summaries no longer reference them).

The whole flow is async with a deadline (e.g., 30 days) appropriate to GDPR
/ SOC-2 expectations.

## Secrets In Memory

- **Never** persist tool credentials in any memory tier. Tool calls reference
  vault entries by id; the secret is fetched at tool execution and stays in
  the sandbox/tool container.
- The redactor scrubs anything that looks like a secret (PEM, JWT, AWS
  access key shape) on every write. False positives are cheap; false
  negatives are not.

## Anchors

- SOC-2 readiness driver - `blackbox-experience.md` #5,
  `blackbox-experience.md` #7.
- Multi-tenant + isolation requirements from BlackBox bullet 1
  (`resume.txt`).
- Memory poisoning / cross-tenant question - `blackbox-experience.md` #22.
- Microsoft analog: secure multi-tenant ML, RLS-style isolation,
  threat-modeling discipline (`microsoft-experience.md` #7, #10, #18).
