# 07 — Security and Isolation (Infrastructure Plane)

> Scope: identity, authentication, authorization, network isolation, tenant isolation, secrets, residency, audit integrity, compliance posture, supply chain, model-provider isolation, DR, and security-specific failure modes for the Multi-Persona AI Banker (Retail, SME, CFO) on a shared platform.
>
> Out of scope (handed off to `15-guardrails.md`): prompt injection detection, jailbreak resistance, output content scanning, tool-call schema validation, hallucination filters, escalation policy. This file stops at *infrastructure isolation*; behavioral safety is the guardrails layer.

---

## 1. Threat model summary

The platform serves three personas (Retail, SME owner, CFO of a multi-entity group) on shared compute and storage, with money-moving capabilities behind human-in-the-loop (HITL) gates. The threat model is built around a small, named set of assets and trust boundaries so every later section maps cleanly back to a concrete risk.

### Assets

| Asset | Why it matters | Worst-case damage |
|---|---|---|
| Customer financial data (balances, transactions, statements, account-aggregator pulls) | PII + financial PII; DPDP + GDPR scope | Regulator fines, mass breach, brand-ending event |
| Money-movement authority (sweep, delay-payment, FX-hedge, vendor-disbursement) | Direct economic loss vector | Wire fraud, insider theft, mass-debit incident |
| Agent memory (episodic, semantic, working) | Carries cross-session secrets, learned preferences, and prior tool outputs | Cross-tenant leakage, profile reconstruction attacks |
| Model prompts and system instructions | Trade secret + safety control surface | Jailbreak templates leak, persona-bypass primitives discovered |
| Audit log | The only durable narrative of who did what | Tampering hides fraud; gaps invalidate SOC-2 |
| Tool-provider credentials (Plaid, AA, payment rails, model vendors) | Bearer keys with significant blast radius | Credential leak → cross-tenant abuse |

### Trust boundaries

```
User device  ──╮
              ├── Boundary A: TLS + WAF
              ▼
            Edge (NLB → ALB → WAF)
              │
              ├── Boundary B: mTLS + workload identity
              ▼
        API Gateway (OIDC enforcement, persona resolver)
              │
              ├── Boundary C: tenant-scoped context binding
              ▼
        Agent Orchestrator (LangGraph supervisor)
              │
       ┌──────┼──────────────┐
       │      │              │
       ▼      ▼              ▼
   Tool      Model         Memory
   Plane     Router        (Postgres+RLS, Redis, pgvector)
       │      │              │
       │      └─ Boundary D: PII redaction + provider isolation
       │
       ├── Boundary E: WASM sandbox (money-moving / risky tools)
       └── Boundary F: egress proxy (whitelisted external APIs)
```

### Key threat classes (and which section addresses them)

| Threat class | Primary mitigation section |
|---|---|
| Cross-tenant data leakage (a request for tenant A sees tenant B's row) | §6 (multi-tenant data isolation), §4 (network), §3 (authz) |
| Agent hijack via prompt injection | `15-guardrails.md` (behavioral); this file limits blast radius via §3, §5, §7 |
| Money-moving without proper authority | §3 capability matrix + §5 WASM sandbox + §9 audit + HITL (in `15-guardrails.md`) |
| Audit-log tampering | §9 hash-chained WORM log |
| Model provider compromise (LLM vendor leaks our prompts or returns tainted output) | §12 model router + PII redaction |
| Internal lateral movement | §4 east-west mTLS + deny-by-default mesh |
| ML supply chain (poisoned dep, malicious model weight, typo-squat) | §11 SLSA + CodeQL + admission controller |

The resume anchors for this threat model are direct: WASM sandbox plane isolating 1M+ daily code executions under SOC-2 (resume.txt:49-50) and Microsoft secure multi-tenant ML infra on Kubernetes + Azure with VNet and identity (resume.txt:88-94) are the operational templates we extend; CodeQL + GitHub Advanced Security in CI/CD with standardized threat modeling (resume.txt:93-94) defines the build-time half.

---

## 2. Identity and authentication

### 2.1 User authentication

| Persona | Primary auth | MFA | Step-up triggers |
|---|---|---|---|
| Retail | OAuth2/OIDC with partner-bank IdP federation | Optional (mandatory for >₹50k actions) | Money-movement, account-link, persona elevation |
| SME owner | OAuth2/OIDC + MFA mandatory | TOTP or WebAuthn | Vendor add, payroll trigger, sweep > ₹1L |
| CFO (multi-entity) | OAuth2/OIDC + MFA mandatory + device binding | WebAuthn preferred | Any cross-entity transfer, FX-hedge, ledger close |
| Partner integrations (bank, accounting SaaS) | mTLS client certs at edge | n/a (cert auth) | n/a |

Session tokens are short-lived (15 min access, 12 h refresh) and bound to a device fingerprint plus IP-band. The persona resolver runs **after** OIDC verification and **before** the agent supervisor receives any context — a low-privilege user cannot self-elevate by injecting persona claims into the prompt because the persona binding is server-side in the gateway, not in the conversation.

### 2.2 Service-to-service identity

Internal workloads use **SPIFFE/SPIRE workload identities** issued as X.509 SVIDs, with short-lived certs (1-hour TTL, rotated automatically). Every service-to-service call inside the cluster uses mTLS with the SVID as the client cert; the destination service validates the SPIFFE ID against an allow-list per route.

This is the same identity model used in the TunDRA QUIC secure-protocol deployment on 1M+ instances (resume.txt:97-98) — a uniform workload identity layer, certs rotated automatically, no static service credentials anywhere in production. The lessons carry forward: certificate rotation must be invisible to application code (sidecar handles renewal), and revocation must be near-instant (CRL distribution under 60s).

### 2.3 Customer-bound tool delegation tokens

Every tool invocation carries a **delegation token** that the orchestrator mints just-in-time:

```
delegation_token = {
  tenant_id,
  user_id,
  persona,
  tool_name,
  caveats: { max_amount, max_count, deadline, single_use: true },
  exp: now + 60s,
  sig: HMAC(tenant_signing_key, payload)
}
```

The tool worker verifies the signature, checks the tool-name match (one token = one tool call), and refuses if `exp` is past. This prevents a captured token from being replayed against a different tool or after the call window. The macaroon-style caveats (§3.3) live inside the same envelope.

---

## 3. Authorization model

Authz is enforced at three layers, on the principle that no single point should be able to grant a capability it does not own.

### 3.1 Three layers

1. **Persona-level capability matrix** at the Tool Router. "Can persona X invoke tool Y at all?" — coarse-grained, infrequently changed.
2. **Tenant-level policy** at the Policy Engine. "Has tenant T enabled this tool? Are the per-tenant amount caps respected?" — billing-tier driven.
3. **User-level entitlements** at the data layer (PG RLS plus app-layer scope checks). "Can user U see this specific row?" — fine-grained, per-request.

A money-moving action only proceeds when all three return ALLOW. Failure at any layer is logged with the layer that denied it, which is critical for SOC-2 CC6 evidence.

### 3.2 Capability matrix by persona × tool

| Tool | Class | Retail | SME owner | CFO | Notes |
|---|---|---|---|---|---|
| `account-balance` | read-only | ✓ own | ✓ entity-wide | ✓ all entities | RLS enforces row scope |
| `txn-history` | read-only | ✓ own | ✓ entity-wide | ✓ all entities | Same |
| `budget-update` | read + act (local) | ✓ | ✓ | ✓ | Memory write only |
| `savings-suggestion` | read + act (local) | ✓ | ✓ | ✓ | No external side effect |
| `delay-payment` | money-moving | HITL required | HITL required | auto under policy + log | Caveat: max_amount |
| `sweep` (intra-entity) | money-moving | ✗ | ✓ HITL | ✓ auto under policy | Caveat: max_amount, daily_cap |
| `fx-hedge` | money-moving | ✗ | ✗ | ✓ HITL + approver chain | Approver chain (§3.4) |
| `vendor-disburse` | money-moving | ✗ | ✓ HITL | ✓ HITL | Always HITL regardless of amount |
| `ledger-close` | structural | ✗ | ✗ | ✓ HITL + dual-control | Two CFO-level approvers |

Read-only tools execute in normal Go workers under stricter egress whitelisting. Read + act (local) tools also run in normal workers but write only to per-tenant memory. **Money-moving tools always execute in the WASM sandbox plane (§5).**

### 3.3 Tool capability tokens (macaroon-style)

A capability token carries inline *caveats* that the verifier can check without contacting the issuer. Caveats narrow the bearer's rights monotonically — caveats can only restrict, never expand.

| Caveat | Example value | Enforcement point |
|---|---|---|
| `tenant` | `tenant_8a3f...` | Tool worker before any data fetch |
| `user` | `user_29bc...` | Tool worker |
| `persona` | `sme_owner` | Tool worker checks against capability matrix |
| `max_amount` | `50000` (in minor units) | Tool worker before submitting to rail |
| `max_count` | `1` | Single-use enforcement |
| `deadline` | `2026-05-21T14:32:11Z` | Tool worker rejects on expiry |
| `mfa_grade` | `webauthn` | Tool worker rejects if session has lower MFA |

### 3.4 Approver chains (CFO-tier money movement)

For CFO-level actions above tier thresholds (e.g., FX-hedge > $500k, ledger-close), the policy engine requires a **dual-control approver chain**: the initiator and a second pre-registered approver from the same tenant must both sign the action within a 10-minute window. The orchestrator pauses the agent loop on a `WAITING_FOR_APPROVAL` state; both signatures are independently audit-logged. This is HITL infrastructure (`15-guardrails.md` covers HITL *policy*); this file covers the *enforcement plumbing*.

---

## 4. Network isolation

### 4.1 Edge

Public ingress flows through `NLB → ALB → WAF`. The WAF runs:

- Standard OWASP Top 10 managed rule set.
- Bot defense rule set (challenge on suspicious UA/ASN combinations).
- Custom rules for prompt-injection-suspect payloads (very high-noise — the WAF is the first sieve; the real injection detection lives in `15-guardrails.md`).
- Geo-restriction per residency policy (an India-region tenant's traffic is rejected at the EU/US edge to prevent residency-bypass via traffic routing).

### 4.2 Internal VPC

The platform sits in a single VPC per region with private subnets per tier (edge, gateway, orchestrator, tool plane, data). Tier-to-tier traffic is allowed only via explicit security-group rules. There is **no direct internet egress** from the orchestrator, tool workers, or data tier — egress goes through a NAT/egress proxy that enforces an allow-list of destinations: Plaid, Account Aggregator gateways, payment rail endpoints, model-provider APIs, OCSP/CRL distribution points. Any other egress attempt produces an immediate alert and a denied audit entry.

### 4.3 Service mesh

Istio (or Linkerd, depending on cluster) enforces:

- mTLS for all east-west traffic, certs issued by SPIRE.
- Deny-by-default authorization at the proxy; explicit `AuthorizationPolicy` per service pair.
- Per-service rate limits — an orchestrator pod cannot suddenly issue 100× normal traffic to the memory tier without tripping a circuit.

### 4.4 Per-tenant VPC option (CFO enterprise tier)

For tenants paying > $100k/month — typically large multi-entity CFO customers — we offer a **dedicated VPC** with VPC peering to the shared control plane. Their tool plane, memory tier, and Redis are physically isolated. The shared platform retains only the API gateway and the model router for them; everything stateful is in the dedicated VPC. The choice is per-tenant, billed accordingly, and the operational template is the Microsoft VNet-isolation pattern (resume.txt:88-94): one VNet per tenant, dedicated NICs, dedicated GPU node pools where applicable, identity-scoped at the resource group.

---

## 5. Tool sandbox isolation

Risky tools — defined as anything that (a) executes money-moving side effects, (b) calls a payment rail, (c) writes to a tenant-affecting external system — run in the **WASM sandbox plane**. The model is taken directly from the production deployment in the resume that isolated 1M+ daily code executions under SOC-2 (resume.txt:49-50).

### 5.1 Sandbox properties

| Property | Mechanism |
|---|---|
| Sealed compute | WASM module loaded into a wasmtime runtime with no host filesystem, no host process, no syscalls except via capability-passed handles |
| No direct network | The only egress is a host-provided egress proxy function; the proxy enforces destination allow-list and amount caveats |
| Deterministic | Wall clock and randomness are injected as capabilities; same inputs produce the same outputs (critical for audit replay) |
| Time-bounded | 5-second wall clock cap per invocation; sandbox is torn down after each call |
| Ephemeral | One sandbox per call, no in-memory carry-over between calls — even within the same agent loop, the next tool call gets a fresh sandbox |
| Memory-bounded | 64 MB cap; OOM kills the call and returns a structured error |

### 5.2 Why WASM and not container per call

Spinning a container per call costs hundreds of milliseconds and at 1M+ daily executions becomes a scale and cost problem. WASM module instantiation is sub-millisecond and we already proved this works at SOC-2 scale (resume.txt:49-50). Containers remain in the picture for the *non-sandboxed* read-only worker fleet — the sandbox is reserved for the small set of high-blast-radius tools where the cost is justified.

### 5.3 Read-only tool isolation

Read-only tools (`account-balance`, `txn-history`, `savings-suggestion`) run in normal Go workers in the tool plane subnet, with:

- A network policy allowing only outbound to the data tier and the egress proxy.
- A per-worker process budget (one in-flight call at a time).
- Stricter egress whitelisting than the sandbox plane (these workers can hit the AA gateway, but never a payment rail endpoint).

---

## 6. Multi-tenant data isolation

The first rule of multi-tenant: **never rely solely on the application-layer `WHERE tenant_id = ?` filter**. A bug, a forgotten predicate, an internal admin tool — any of these can pierce app-layer-only isolation. We enforce isolation at the storage layer where the app cannot accidentally bypass it.

### 6.1 Postgres — row-level security (RLS)

Every customer-data table has an `RLS` policy:

```sql
CREATE POLICY tenant_isolation ON accounts
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
```

The connection-pool layer sets `app.tenant_id` per checked-out connection using the value resolved by the gateway. A query without a tenant context simply returns zero rows — never a leak to another tenant. **A mandatory CI test** asserts that a connection scoped to tenant A returns zero rows from data inserted under tenant B; this test runs on every PR.

### 6.2 Redis

Per-tenant key prefix (`tenant:{id}:...`) plus Redis ACL users restricted to their prefix. A tenant's session worker holds an ACL-bound connection — it physically cannot SCAN another tenant's keyspace because the ACL denies it.

### 6.3 Vector store (pgvector)

Two-mode isolation by tenant tier:

- **Shared index with metadata filter:** `tenant_id` is a metadata column; every search includes `WHERE tenant_id = ?` plus PG RLS on the underlying table. Standard tier.
- **Per-tenant namespace:** Top-tier tenants get a dedicated index. Costs more in storage and operations, but provides physical isolation for memory embeddings — important when the embeddings encode sensitive context that, even fuzzed, might leak via nearest-neighbor queries.

### 6.4 Knowledge base

Same two-mode choice: tenant-scoped index OR namespaced shared index. The CFO enterprise tier gets tenant-scoped by default; SME and Retail share a namespaced index with metadata filtering.

### 6.5 Object storage

S3 (or equivalent) uses per-tenant prefixes plus per-tenant KMS CMKs for sensitive data (statements, signed advice records, exported reports). The bucket policy denies any `GetObject` that doesn't match the prefix tagged against the caller's IAM role.

---

## 7. Secrets management

| Secret class | Store | Rotation | Notes |
|---|---|---|---|
| App secrets (DB creds, service keys) | HashiCorp Vault | Auto, 24h | Vault Agent sidecar; no app-readable env vars |
| Envelope encryption keys | KMS (cloud-managed) | Annual + on-incident | Per-region KMS for residency |
| Per-tenant CMK | KMS, enterprise tier | Tenant-driven | CFO tier may BYOK |
| Model-provider API keys | Vault, per-tenant where SLA differentiated | 30 days or on-event | Cost attribution tagged on the key |
| Tool-provider credentials (Plaid, AA, payment rails) | Vault | 90 days | Fetched at tool invocation; never cached in app memory beyond a single call |
| Service mesh certs (SPIRE) | SPIRE server | 1 hour | Handled in §2.2 |

Two principles that flow through every row:

1. **No long-lived secrets in environment variables.** Vault Agent fetches at runtime and rotates in place.
2. **Audit trail on every fetch.** Vault writes an audit entry per secret read; that entry joins the application audit log (§9) on `request_id`.

---

## 8. Data residency and sovereignty

Residency is a *tenant-level* property bound at onboarding. The orchestrator binds a tenant to one **home region** and stamps every request with the resolved region; the data plane (PG, Redis, pgvector, object storage) enforces region affinity.

| Jurisdiction | Region | Regulatory frame |
|---|---|---|
| India MAU | `ap-south-1` (Mumbai) | DPDP Act (India) |
| Diaspora EU | `eu-west-1` | GDPR |
| US | `us-east-1` | CCPA, state laws |
| SG / other APAC | `ap-southeast-1` | PDPA, local |

### 8.1 Cross-region access

Cross-region read is a *special case*. A CFO of a multi-entity group with entities in India and EU may need to view both — the orchestrator handles this by spawning a region-local sub-agent in each region and joining redacted summaries in the user's home region. **Raw rows do not cross the boundary.** Any cross-region row read requires an explicit legal-review-approved policy entry and is audit-logged with a `cross_region_access` event.

### 8.2 Backups and DR copies

- Backups encrypted with regional KMS keys; no cross-region KMS key sharing.
- Cross-region replication for DR is **explicitly off by default** and turned on per-tenant only after legal review.
- The India region's DR copy is in another India AZ, not in another country. Same pattern in EU and US.

---

## 9. Audit log integrity

The audit log is the only durable narrative of the system's behavior. SOC-2, RBI, and forensic incident response all assume it is tamper-evident. We achieve that with:

### 9.1 Hash-chained log

Each audit entry contains:

```
entry = {
  seq_no,
  ts,
  tenant_id,
  actor (user, agent, service),
  event_type,
  payload_hash,
  prev_hash,
  this_hash = sha256(prev_hash || payload_hash || ts || seq_no)
}
```

Any insertion, deletion, or modification of an entry breaks the chain. A daily job recomputes the chain and alerts on mismatch.

### 9.2 External anchoring

Daily, the latest `this_hash` is posted to an external timestamp authority (RFC 3161 TSA) and to an internal append-only ledger maintained in a separate trust domain (different IAM root, different KMS region). This means tampering would require collusion across at least two trust domains plus a third party.

### 9.3 WORM retention, 7 years

The audit log is **write-only**. Reads are restricted to a small `auditor` role. The retention policy enforces 7-year WORM via S3 Object Lock in compliance mode — once written, an entry cannot be deleted by anyone, including AWS root, for 7 years. SOC-2 CC7 mapping (§10) points at this.

### 9.4 What gets logged

| Event class | Logged? | Includes |
|---|---|---|
| Persona resolution | Yes | Resolved persona, evidence (claims), gateway request id |
| Persona transition (e.g., SME → CFO mode for a multi-role user) | Yes | Before/after, MFA grade, justification |
| HITL approval | Yes | Approver(s), action, caveats applied |
| Money-moving action | Yes | Tool, amount, rail, response, sandbox attestation |
| Model call with sensitive context | Yes | Model id, redaction hash (not raw prompt), latency, token counts |
| RLS denial / authz denial | Yes | Layer that denied, requested action |
| Cross-region access | Yes | Source region, target region, scope of read |
| Secret fetch | Yes (joined from Vault audit) | Path, requester SPIFFE ID |

Note that the **raw prompt is not stored** — a hash of the redacted prompt is stored. The full redacted prompt sits in a separate, shorter-retention bucket protected by the same RLS rules as the user's data. This separation makes right-to-erasure (§10) tractable without breaking audit integrity.

---

## 10. Compliance posture

### 10.1 SOC-2 Type 2 control map (selected)

| Control | What it requires | Concrete artifact in this design |
|---|---|---|
| CC2 (communication) | Internal communication of controls + commitments | `15-guardrails.md` policy register + customer-facing AI disclaimer + this document |
| CC6.1 (logical access — restriction) | Restrict logical access | §2 SPIFFE workload identity, §3 three-layer authz, §6 PG RLS |
| CC6.2 (logical access — provisioning) | Registration / authorization of users | OIDC + persona resolver + MFA matrix (§2.1) |
| CC6.6 (logical access — boundary protections) | Boundary protections | §4 WAF + VPC + mesh deny-by-default |
| CC6.7 (logical access — restrictions on transmission) | Encrypt in transit | mTLS everywhere east-west; TLS 1.3 at edge |
| CC6.8 (prevent malicious software) | Anti-malware controls | §11 signed images + admission controller + image scanning |
| CC7.1 (system ops — monitoring) | Detect anomalies | §9 audit log + metric anomaly detection |
| CC7.2 (system ops — incidents) | Respond to incidents | §14 failure-mode playbooks |
| CC7.3 (system ops — evaluations) | Evaluate incidents | Quarterly tabletop + DR drill (§13) |
| CC8.1 (change management) | Authorize and document changes | §11 PR review + threat-model-per-major-change |

The resume's SOC-2 production experience (resume.txt:49-50) is the operational backbone — those controls were already living controls in a multi-tenant high-throughput environment.

### 10.2 DPDP (India)

- **Consent management** at onboarding: granular, withdrawable, versioned. The user's consent record is itself stored under DPDP-aligned terms and is the gating condition for any data fetch from AA or Plaid for that user.
- **Right to erasure**: a redaction workflow that:
  1. Marks the user `erased` in the canonical profile.
  2. Propagates to memory tiers (episodic, semantic, working) by deleting embeddings and content rows under the user.
  3. **Redacts** (not deletes) the corresponding audit entries — replaces PII fields with hashes; the event narrative survives, the personal content does not. This is the only way to honor both DPDP's erasure right and SOC-2 / RBI's audit-immutability requirement.
- **Data principal grievance** path: in-app and email, with 7-day SLA.

### 10.3 RBI — AI in financial services

| Requirement | Mechanism |
|---|---|
| Model governance log | Per-deployment model card + version log + change approval in §11 |
| Explainability for advice | Every agent advice carries a `rationale` field grounded in tool outputs; the rationale and the underlying tool outputs are stored together with the advice |
| Customer-facing disclaimer | UI banner + onboarding consent: "AI assists; you remain in control. Money-moving actions require your authorization or pre-approved policy." |
| Money-movement traceability | Either auto-approved under a documented policy (caveats in the capability token, §3.3) or HITL approval — both are audit-anchored |
| Customer grievance channel for AI-related complaints | Dedicated category in the grievance system |

### 10.4 GDPR (diaspora)

- DPO contact published.
- DPIA on file for each high-risk processing activity (money-moving, automated advice).
- Lawful basis declared per processing activity; legitimate-interest assessments where applicable.
- Cross-border transfer mechanism (SCCs) for any inevitable EU→non-EU operational data.

---

## 11. CI/CD and supply chain

### 11.1 Build-time controls

- **CodeQL + GitHub Advanced Security** on every PR (resume.txt:93-94). Required check; cannot be bypassed.
- **Secret scanning** with push protection on every repo. Detected secrets block the push.
- **Dependency review** on every PR — new high/critical CVE in a transitive dependency fails the check.
- **Threat modeling per major change** (resume.txt:93-94) — major-change PR template requires a STRIDE table; reviewer must explicitly approve the threat model section.

### 11.2 Supply chain — SLSA-2

| Property | Mechanism |
|---|---|
| Provenance | Built in GitHub Actions on isolated runners; `slsa-github-generator` emits attestation |
| Signed images | `cosign` signs each image with a key held in KMS |
| Admission controller | Cluster admission controller (Kyverno or Sigstore policy controller) rejects any image without a valid signature and a recent provenance attestation |
| SBOM | Generated per image (`syft`) and stored alongside the attestation for downstream CVE rescans |

### 11.3 ML supply chain

- Foundation model versions pinned by SHA — no `latest`.
- Embedding models pinned the same way.
- Custom fine-tunes are tracked in a model registry with provenance pointing back to the build artifact and the training data manifest.

---

## 12. Model provider isolation

Every model call goes through the **Model Router** — a proxy service that sits between the orchestrator and any LLM provider (Anthropic, OpenAI, Google, in-house). The orchestrator never holds a provider key; it holds a router token, and the router holds the provider keys per tenant.

### 12.1 Properties

- **Provider key rotation** is automatic and handled by the router (§7), invisible to the orchestrator.
- **PII redaction at the router**: before any provider receives a prompt, the router runs a redaction pipeline that masks account numbers, phone numbers, government IDs, full names where the persona's policy demands it, transaction amounts where the model only needs the *shape* of the request, etc. A hash of the redaction maps back to the audit entry (§9).
- **Response filtering**: the provider's response is parsed for tool calls and content. Content scanning is the guardrails layer's responsibility — see `15-guardrails.md` for the tool-output sanitization and prompt-injection-via-response defenses. This file commits only that the *plumbing* (a single chokepoint, no direct calls bypassing it) exists.
- **Per-tenant provider routing**: a tenant on the enterprise tier may have a dedicated provider account (separate API key, separate cost ledger, separate rate-limit pool). Standard tier uses pooled accounts with per-tenant token accounting.
- **Cost attribution**: every call is tagged with `tenant_id`, `persona`, `tool_context`, and the token counts are billed against the tenant — this is a security control as much as a billing one, because runaway cost is often the first symptom of an agent hijack.

### 12.2 Why a router and not direct calls

A direct call from the orchestrator to a provider means N codepaths to enforce redaction, N codepaths to enforce key rotation, N codepaths to attribute cost. A router collapses all of that to one chokepoint where the controls are audited once. This is the same architectural principle that justified the Microsoft secure multi-tenant ML infra's centralized GPU scheduler (resume.txt:88-94): centralize the trust-sensitive plumbing, distribute only the application logic.

---

## 13. Backup and DR

| Component | RTO | RPO | Mechanism |
|---|---|---|---|
| Transactional Postgres | 30 min | 5 min | WAL streaming to alternate AZ + nightly snapshot to alternate region (where residency permits) |
| Redis (sessions, hot cache) | 5 min | best-effort | Stateless rebuild — sessions re-derived from PG on cache miss |
| pgvector | 30 min | 1 hour | Snapshot + re-embed pipeline as fallback |
| Audit log | 1 hour | 0 (write-through replication) | Cross-region replication, regulator-approved per region |
| Object storage | n/a | 0 (versioned + cross-region per policy) | S3 versioning + replication |
| Vault | 15 min | 5 min | HA cluster + cross-region standby |

### 13.1 DR drill

- **Quarterly tabletop**: one team simulates region loss; another team executes the runbook against a staging DR region.
- **Annual live drill**: cut a non-critical workload to the DR region for 24 hours.
- **Audit log drill** is separate: prove that the cross-region audit replica is byte-identical and the chain (§9.1) still verifies end-to-end.

---

## 14. Failure modes (security-specific)

For each failure mode: how we detect, how we respond, how we limit blast radius.

### 14.1 Compromised model provider

- **Detection**: anomalous response patterns (sudden tool-call frequency change, response entropy drop), provider-side breach disclosure, abnormal cost spike.
- **Response**: Model Router cuts the provider out within minutes; orchestrator falls back to backup provider for that tenant tier.
- **Blast radius limit**: PII redaction at the router (§12) means the provider never had raw account numbers. The provider knew only redacted prompts. Cost-attribution tagging lets us know exactly which tenants' requests went through during the suspected window.

### 14.2 Hijacked tool credential (e.g., Plaid key leaks)

- **Detection**: out-of-pattern API call volume from Plaid logs, IP reputation hits on the source, or our own delegation-token mismatch alarms (if the credential is used outside our infra).
- **Response**: rotate the credential in Vault; the new credential propagates within one Vault lease cycle (minutes).
- **Blast radius limit**: delegation tokens (§2.3) are short-lived and tool-scoped; even if a tool credential leaks, it can only be replayed through the egress proxy from inside our network, which the proxy refuses to do for non-cluster source IPs.

### 14.3 Leaked tenant key (per-tenant CMK)

- **Detection**: CloudTrail KMS-decrypt anomalies, customer-reported.
- **Response**: rotate the CMK; re-encrypt the affected tenant's at-rest data via a background job (envelope encryption makes this an unwrap-and-rewrap of envelope keys, not a full data rewrite).
- **Blast radius limit**: per-tenant CMK means only one tenant's at-rest data is exposed, not the whole platform.

### 14.4 Audit-log tampering attempt

- **Detection**: hash-chain mismatch during daily verification, or external TSA anchor mismatch (§9.2). Mismatch generates a P0 alert.
- **Response**: freeze writes to the affected log range while forensic snapshot is taken; switch to the cross-region replica for continued operation.
- **Blast radius limit**: WORM Object Lock + cross-trust-domain external anchoring means a single insider cannot rewrite history; collusion across two trust domains *plus* the external TSA would be required, and that triple is the SOC-2 / RBI argument for log integrity.

### 14.5 Rogue insider with admin token

- **Detection**: behavioral analytics on admin actions; any admin reading customer data raises an alert; any admin modifying audit-log retention raises a P0 alert (and is blocked by the WORM policy regardless).
- **Response**: revoke the SPIFFE identity at the SPIRE server (next workload heartbeat — under 60s); rotate any secrets the admin had access to; full session forensic.
- **Blast radius limit**: admin roles do not have direct DB access — admin actions go through approved tooling that itself is audit-logged. The only path to raw data for an admin is via a break-glass procedure that requires dual control and is logged with the highest severity.

### 14.6 Persona-resolver bypass

- **Detection**: a request's persona claim does not match the gateway-resolved persona (e.g., a Retail user appears in a CFO-only tool call). The Tool Router rejects and emits a high-severity audit event.
- **Response**: terminate the session, force re-auth at the highest MFA grade, mark the account for review.
- **Blast radius limit**: persona is resolved server-side at the gateway *before* the orchestrator runs, and again checked at the Tool Router (§3.1 — three layers must all agree). A bypass would require defeating all three independent enforcement points; no single bug can grant elevation.

---

## 15. Where guardrails take over

This file ends at *infrastructure isolation*: who is who, what they can call, which network paths exist, where data lives, how secrets flow, how audit integrity is preserved, what compliance maps to what, how the build pipeline is trusted, how model providers are isolated, how we recover. Everything described above is enforced by infrastructure, identity, and policy engines — not by the agent's reasoning.

**Behavioral safety lives in `15-guardrails.md`**: input validation (prompt injection detection, jailbreak resistance, persona-claim sanitization in user input), output scanning (sensitive content in model output, tool-call schema validation, hallucination guardrails for advice), and the escalation/HITL policy that governs *when* an action requires human approval. Those controls run inside the agent loop and shape what the agent is willing to do; the controls in this document shape what the platform makes possible in the first place. The two layers are designed to be independently sufficient against single-class failures and jointly sufficient against any production threat we have modeled — a defense-in-depth that mirrors the layered approach proven across the WASM sandbox plane (resume.txt:49-50), Microsoft's secure multi-tenant ML infra on Kubernetes + Azure (resume.txt:88-94), and the TunDRA QUIC deployment on 1M+ instances (resume.txt:97-98).
