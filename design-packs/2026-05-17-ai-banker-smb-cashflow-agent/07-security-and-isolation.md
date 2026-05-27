# 07 - Security and Isolation

**Scope:** Infrastructure security for the AI Banker for SMB owners. Multi-tenant, India-primary (RBI/DPDP), US/EU secondary (SOC-2/GDPR/CCPA). Target 1M businesses.

**Out of scope (lives in `15-guardrails.md`):** prompt-injection defense, output-content safety, behavioral rate-limits on the LLM itself, tool-gateway capability ACLs at the agent-node level, hallucination guardrails. This document only references those cross-cutting hooks where they intersect infra.

**Resume grounding for this document.** WASM sandbox plane isolating 1M+/day executions under SOC-2 (`resume.txt L49-50`, `blackbox-experience.md #3-5,7`); secure multi-tenant ML infra and isolation strategies at Microsoft (`resume.txt L88-89`, `microsoft-experience.md #7,10`); CodeQL + GitHub Advanced Security and institutionalized threat modeling (`resume.txt L93-94`, `microsoft-experience.md #17-19`); TunDRA QUIC-based secure protocol across 1M+ compute instances (`resume.txt L97-98`, `microsoft-experience.md #20`); 30+ architecture reviews including security (`resume.txt L95-96`); deterministic replay cutting MTTR 60% (`resume.txt L58-59`, `blackbox-experience.md #20`).

---

## 1. Threat model - STRIDE

Applied to the SMB AI Banker. Money-moving and consent-bearing surfaces are the crown jewels; the agentic surface (tool calls, memory, RAG) is a novel threat layer that classical STRIDE under-rates.

| # | Category | Threat | Asset at risk | Attack surface | Primary control | Residual risk |
|---|---|---|---|---|---|---|
| S1 | Spoofing | Stolen tenant JWT replayed against payment API | Payment-initiation endpoint | Mobile app, browser session | Short-lived JWT (15 min access, 24h refresh), `jti` replay cache in Redis (60-min TTL), device-bound key for refresh, MFA step-up on write | Coerced device + active session window |
| S2 | Spoofing | OAuth code interception for AA / bank connect | Account-Aggregator FI token | Redirect URI hijack, mobile deep link | PKCE mandatory, exact-match redirect, per-tenant state nonce, AA consent artifact pinned to `(business_id, purpose_code)` | Malware-controlled handset can still complete the flow |
| S3 | Spoofing | Forged bank webhook claiming "payment succeeded" | Reconciliation state | `webhook.aibanker.in` ingress | Per-provider HMAC signature + provider source-IP allow-list + mTLS where bank supports it; webhook events are *advisory* - truth is reasserted by pull from bank balance API | Bank IP block change → temporary self-DoS, not bleed |
| T1 | Tampering | Modified payment payload mid-flight (amount/beneficiary swap) | Pending payment | Client → API → tool gateway → bank | Canonical-JSON request signed by client (Ed25519 device key) + server re-derives idempotency key from `(business_id, beneficiary_hash, amount, nonce)`; tool gateway re-validates against the user-approved plan diff | Compromised app build can sign a tampered payload |
| T2 | Tampering | Replayed approval token after the user reversed intent | Pending payment | Approval link / push action | Approvals are single-use bearer tokens tied to `(plan_run_id, step_id)`; consumed atomically; revocation propagates within 5s via Redis pub/sub | Race between approve and revoke within ~1s |
| T3 | Tampering | Tampered embeddings in vector store causing biased retrieval | Agent reasoning quality | Ingestion pipeline, vector DB | Signed embedding manifest per ingest batch; per-tenant namespace; row-checksum verified at retrieval; periodic re-embedding diff alarm | Insider with DB write can still poison until next re-embed |
| R1 | Repudiation | Owner denies authorizing a ₹5L payment | Legal/financial liability | Mobile approval flow | MFA on every write + signed audit row including device attestation, push-approval token, biometric assertion bundle, justification-trace hash; 7-year WORM retention | Coerced biometric remains attributable to user |
| I1 | Info disclosure | Cross-tenant bleed via shared LLM prompt cache | Transactions/PAN of other SMB | Provider-side prompt cache, our semantic cache | All cache keys salted with `tenant_id`; provider-side caching disabled for P0/P1 fields; PII redaction layer pre-egress; per-tenant cache namespaces verified by Postgres RLS-style sentinel rows in chaos drills | Provider misconfig outside our control |
| I2 | Info disclosure | Embedding inversion leaking transaction descriptions | Bank statement narration | Vector DB dump | Embeddings stored at-rest with KMS DEK per tenant; tenant DEK destroy on offboard purges retrievability; no embeddings of raw PAN/account numbers (only tokens) | Theoretical embedding inversion on remaining P1 narration text |
| I3 | Info disclosure | Application logs containing PAN/account numbers | Customer trust, DPDP fine | App + agent + provider SDK logs | Structured-logging redaction filter (regex + Luhn + GSTIN/PAN format) at log SDK; CI test asserts no raw P0/P1 fields exit the redactor; sample audit by SOC nightly | Novel field shapes can slip until grammar updated |
| D1 | DoS | Per-tenant flood of "forecast my cashflow" | Agent compute, LLM tokens | Public API | Per-`(tenant, route)` token bucket; per-business monthly LLM-token quota; weighted fair queueing across tiers (Free/Pro/Enterprise) | Adversary across many free tenants - covered by per-IP + per-device fingerprint quotas |
| D2 | DoS | Expensive Monte Carlo forecast abused as compute amplifier | Forecast workers | Authenticated UI | Monte Carlo capped at 10k paths/run, 3 runs/day/business on Free tier; cached deterministic-seed result reused for same input within 1h | Tenant on Enterprise can still burn their own quota |
| D3 | DoS | Agent-loop token burn (tool-call infinite recursion) | Provider spend, latency | Agent runtime | Per-run budget (tokens, wall-clock, tool-call count); circuit breaker on repeated `(node, tool_name, arg_hash)` tuples - detail in `15-guardrails.md` | Novel loop patterns may exhaust budget before tripping |
| E1 | EoP | Low-privilege agent node invoking write tools | Money movement | Tool gateway | Capability allow-list per node ID, signed by graph compiler; gateway rejects on mismatch; write tools additionally require user MFA-bound capability token | Compromised compiler signing key - mitigated by HSM-stored key + dual-control issuance |
| E2 | EoP | Lender-API token abuse to fetch other businesses' offers | Lender consent scope | Lender adapter | Tokens stored per-`(business_id, lender_id)` in Vault, scoped Vault policy `path "lenders/{business_id}/*"`; broker service forbids cross-business fetch | Misconfigured Vault policy - caught by nightly policy diff alarm |
| E3 | EoP | OCR worker escapes sandbox via crafted PDF | Cluster compromise | Email-ingest OCR pipeline | gVisor + read-only FS + no egress + seccomp + 256MB / 30s caps; pattern continues the BlackBox WASM sandbox approach (`resume.txt L49-50`) for untrusted code, applied here to untrusted *data* | gVisor zero-day; mitigated by namespace-level network policy denying all egress |

Residual-risk theme: the surfaces we cannot fully close are (a) compromised end-user devices, (b) provider-side cache/policy misconfig, (c) novel embedding-inversion research. These feed the incident-response runbooks in §12.

---

## 2. Identity and authentication

| Concern | Choice | Why | Residual |
|---|---|---|---|
| SMB user auth | OIDC: Google, Apple, email+passkey, **mobile OTP via DLT-templated SMS** for India fallback | India SMB owners often onboard via WhatsApp/SMS; passkey-first with OTP fallback | SMS interception in low-coverage regions |
| MFA on writes | Required on any payment, GST filing, loan acceptance, beneficiary add. TOTP first, SMS OTP fallback, biometric on mobile | Repudiation defense (R1); legal-evidence quality | TOTP secret on rooted device |
| Tenant context | Signed JWT `{tenant_id, business_id, user_id, scopes, exp, jti, dev_id}`. Start HS256 (single issuer), migrate to RS256 + JWKS as services federate. Verified at *every* hop, not just edge | Microsoft pattern: never trust an upstream's claim of who the caller is (`microsoft-experience.md #10`) | Token-theft window equals access TTL (15 min) |
| Service-to-service | mTLS via SPIFFE/SPIRE; SVIDs valid 24h, auto-rotated; identity = `spiffe://aibanker/<region>/<service>` | Identity-first networking; aligns with the secure-protocol mentoring track from Microsoft (`resume.txt L93`, `microsoft-experience.md #16`) | Compromised SPIRE control plane → ring-fenced in its own namespace + HSM-rooted CA |
| Intra-cluster bulk transport | **TunDRA-style QUIC tunnels** for high-fanout intra-region links (LLM gateway → model providers, telemetry mesh shippers) where the mTLS-on-TCP handshake tax matters; reuses the protocol class shipped to 1M+ compute instances at Microsoft (`resume.txt L97-98`, `microsoft-experience.md #20`) | 0-RTT resume cuts agent-step latency; connection migration survives NAT rebinding for mobile-originated streams | QUIC middlebox interference in some Indian ISPs - falls back to TLS 1.3/TCP |
| Third-party provider creds | **HashiCorp Vault**; dynamic secrets for Postgres/AWS/RabbitMQ; static creds (bank, lender, payroll APIs) under tenant-scoped paths; every fetch audited | "No secrets in code, env, image" is a hard rule | Vault root-token compromise - root sealed, unseal keys split via Shamir 3-of-5 |
| AA consent | RBI Account Aggregator framework: `ConsentRequest → ConsentHandle → encrypted FI-Data`. Consent artifact stored signed, with `purpose_code`, `frequency`, `expiry`, `data_life`. Data fetched under that consent is purged or re-fetched per consent terms | Compliance plus minimization | User-revoked consent must propagate to caches - handled by §9 erasure flow |

---

## 3. Authorization - RBAC + ABAC

Two-layer model. RBAC for coarse role gates; ABAC for region, risk-tier, and per-business scoping. Per-agent-node capability allow-lists live in `15-guardrails.md` and are referenced, not duplicated.

### 3.1 Roles × actions matrix

| Action | Owner | Accountant | Viewer | Auditor | Lender (consented R/O) |
|---|---|---|---|---|---|
| `view_dashboard` | yes | yes | yes | yes | scoped |
| `view_transactions` | yes | yes | yes | yes | scoped (consent window) |
| `initiate_payment` | yes | yes | no | no | no |
| `approve_payment ≤ ₹5L` | yes | yes | no | no | no |
| `approve_payment > ₹5L` | yes + 2nd approver | yes + 2nd approver | no | no | no |
| `send_invoice_reminder` | yes | yes | no | no | no |
| `file_gstr` | yes | yes | no | no | no |
| `accept_loan_offer` | yes | no | no | no | no |
| `add_beneficiary` | yes (24h cool-off) | yes (24h cool-off) | no | no | no |
| `export_data` | yes | yes | no | yes | no |
| `view_audit_log` | yes | yes | no | yes | no |
| `manage_users` | yes | no | no | no | no |
| `connect_bank_account` | yes | no | no | no | no |

### 3.2 ABAC overlay

- `attr.region ∈ {IN, EU, US}` - must match resource region; cross-region read denied at the data layer (§4, §9).
- `attr.risk_tier ∈ {low, med, high}` - derived from velocity model (§11); `high` blocks single-approver payments above ₹50k.
- `attr.device_attested ∈ {true, false}` - payments above ₹1L require `true` (Play Integrity / App Attest).
- `attr.session_age_minutes` - writes blocked beyond 60 min without re-auth.

Decision engine: OPA sidecar; policies in Rego; bundled and signed; admission controller refuses pods running unsigned bundles. Decision latency budget 5 ms p99 (cached); cold path 15 ms.

---

## 4. Network boundaries

| Tier | Boundary | Control | Note |
|---|---|---|---|
| Edge | CloudFront / Cloudflare → ALB | WAF (managed + custom rules), mTLS optional for partner API, rate-limit per IP and per device fingerprint | DDoS L7 shield |
| App tier | Private subnets per AZ | NodePort closed; only ALB and internal NLBs reach pods | No public IPs |
| Egress to providers | NAT GW + provider IP allow-list; **bank-whitelisted egress** rides NLB EIPs (static IPs registered with each bank), see `03-architecture.md` LB section | Some banks require fixed source IPs - NLB EIPs are pinned and change-controlled | EIP churn requires compliance ticket + bank-side update |
| Inbound webhooks | Dedicated `webhook.aibanker.in` subdomain → segregated NLB → webhook-ingest service | Per-provider HMAC sig, mTLS where supported, IP allow-list per provider; webhook events treated advisory, never authoritative | Spoofing class S3 |
| Cross-region | Private VPC peering via AWS Transit Gateway; no internet hop; data plane traffic stays on AWS backbone | Required for control-plane sync (auth, billing); user data does not cross region | Bug bar: any service path that *could* serialize a row across regions trips an alarm |
| Intra-cluster | Calico/Cilium NetworkPolicies, default deny; mTLS via SPIFFE; **TunDRA-class QUIC tunnels** for the LLM gateway and telemetry shipper hot paths (`resume.txt L97-98`) | mTLS-on-TCP handshake cost dominates at 50M spans/day shipping - same scale class as the BlackBox telemetry mesh (`blackbox-experience.md #20`) | Operational complexity - QUIC observability tooling thinner than TCP |
| K8s namespaces | Tenant-tier-segregated (`free`, `pro`, `enterprise`), one namespace per data-domain service | NetworkPolicy denies cross-namespace except via service mesh ingress | Namespace ≠ tenant; per-tenant namespace only for Enterprise (§6) |

---

## 5. Data classification and encryption

### 5.1 Classes

| Class | Examples | At-rest | In-transit | Special handling |
|---|---|---|---|---|
| **P0** | Bank credentials, payment OTPs, refresh-token signing keys, KEKs | Vault + CloudHSM; never on disk in plaintext | mTLS only; mTLS-pinned for HSM | Field-level encryption inside row; never logged; redaction in §6 |
| **P1** | Bank account numbers, PAN, GSTIN, Aadhaar, payroll amounts, transaction rows, embeddings of P1 | KMS-encrypted EBS/EFS, Aurora TDE, S3 SSE-KMS; per-tenant DEK; KEK in CloudHSM | TLS 1.3 / mTLS | Tokenized at app boundary; raw only behind a detokenize call audited per access |
| **P2** | Conversation transcripts, agent plans, justification traces | KMS-encrypted; per-tenant DEK; 90-day default retention | TLS 1.3 | PII scrubbed before LLM-provider egress |
| **P3** | Telemetry, anonymized analytics, system metrics | KMS-encrypted; shared key | TLS 1.3 | Aggregation only |

### 5.2 Mechanics

- **Envelope encryption** - per-tenant DEK wraps row data; DEK wrapped by region KEK; KEK in CloudHSM. Tenant DEK *destruction* is the GDPR/DPDP erasure primitive (§9).
- **Field-level encryption** for P0 inside Postgres rows (`pgcrypto` + KMS-issued DEKs).
- **Tokenization** for PAN/Aadhaar/account-number - token at app layer, detokenize requires service identity + user-session JWT + reason code, all logged.
- **Key rotation** - KEKs 365d, DEKs 90d background re-wrap, JWT signing keys 30d, webhook signing keys 180d, payment-rail creds 30d, generic provider creds 90d.
- **Crypto agility** - algorithm IDs stored next to ciphertext; rotation runbook covers AES-GCM → AES-GCM-SIV migration, and TLS suite changes.

---

## 6. Multi-tenant isolation

The default is **logical isolation with hard enforcement**; Enterprise tier upgrades to **physical isolation** for compute and data. Pattern carried over from BlackBox WASM sandbox plane (`resume.txt L49-50`, `blackbox-experience.md #6`) and the Microsoft multi-tenant ML infra (`resume.txt L88-89`, `microsoft-experience.md #7,10`).

| Layer | Free / Pro | Enterprise | Enforcement |
|---|---|---|---|
| Database row | `tenant_id` column on every row; Postgres **RLS policies** keyed on `current_setting('app.tenant_id')`; session var set by connection-pool middleware from JWT | Dedicated DB schema; optionally dedicated Aurora cluster | RLS + a CI test that fails when any new table lacks an RLS policy |
| Vector store | Per-tenant namespace in Qdrant; cross-namespace query forbidden in adapter | Dedicated Qdrant collection | Adapter-side allow-list + chaos drill: insert sentinel rows under tenant A, assert tenant B retrieval returns zero |
| Cache (Redis) | Key prefix `t:{tenant_id}:…`; ACL user per tier; AUTH per pool | Dedicated Redis shard | Lint: any `SET`/`GET` without prefix-builder fails build |
| Object storage | S3 prefix per tenant; bucket policy denies cross-prefix; KMS DEK per tenant | Dedicated bucket | S3 Access Analyzer + nightly diff |
| Compute | Shared agent workers, namespace per tier; **gVisor sandbox for OCR / PDF parsing workers** (untrusted data) | Dedicated worker pool, dedicated node group with taints | gVisor + read-only FS + no egress; same isolation discipline as the WASM sandbox plane (`blackbox-experience.md #3-5`) but for untrusted input rather than untrusted code |
| Networking | NetworkPolicies per namespace, default deny | Dedicated namespace + dedicated SPIFFE trust domain segment | NetworkPolicy CI test; periodic Cilium drift scan |
| Secrets | Vault path `tenants/{tenant_id}/...`; policy requires JWT subject match | Dedicated Vault namespace | Vault audit log replayed nightly for cross-tenant access attempts |

Residual: noisy-neighbor on shared LLM-provider quotas remains for Free/Pro - mitigated by per-tenant token buckets, not by physical isolation.

---

## 7. Secret management

| Item | Where | Rotation | Access |
|---|---|---|---|
| Postgres app users | Vault dynamic secrets, 1h TTL | continuous | Pod identity via SPIFFE → Vault Kubernetes auth |
| AWS IAM | Vault dynamic STS, 1h TTL | continuous | per-service Vault role |
| RabbitMQ creds | Vault dynamic, 24h TTL | continuous | per-service role |
| Bank/lender/payroll API creds | Vault static, tenant-scoped path | 30 day for payment-rail; 90 day generic | Live JWT subject must match Vault policy `path "providers/{business_id}/*"` |
| JWT signing key | CloudHSM-backed | 30 day | KMS API; never extractable |
| Webhook signing keys | Vault | 180 day | webhook-ingest service identity only |
| Image-signing key (cosign) | CloudHSM | 365 day, dual-control rotation | release pipeline identity only |
| KEK | CloudHSM | 365 day | KMS API |

Rules:

- **No secrets in code, container image, or env vars.** Init-container fetches at boot; app reads from tmpfs.
- **Pre-commit `gitleaks`** and **CI GitHub Advanced Security secret scanning** (`resume.txt L93-94`, `microsoft-experience.md #17`); PR blocked on finding.
- **Emergency revoke**: `vault-break-glass` runbook revokes all dynamic leases for a service in <60s; static creds force-rotated via provider API where possible (bank creds may need human escalation).

Residual: provider creds that lack rotate-via-API (some PSU banks) require ops human-in-loop, tracked as a known risk in the SOC-2 control set.

---

## 8. Audit log

Every money-touching, consent-touching, or filing action emits an audit row. Append-only.

### 8.1 Schema

```
audit_log (
  audit_id          uuid pk,
  business_id       uuid,
  actor             jsonb,        -- {type, user_id|service, dev_id, ip, ua}
  action            text,         -- e.g. payment.initiate, payment.approve, gst.file, consent.grant
  target            jsonb,        -- {type, id, hash}
  before            jsonb,        -- snapshot pre-mutation
  after             jsonb,        -- snapshot post-mutation
  justification_run_id uuid,      -- ties to agent plan/trace
  policy_decisions  jsonb,        -- OPA decision IDs + inputs hash
  mfa_evidence      jsonb,        -- {method, ts, challenge_id, attestation}
  signature         bytea,        -- Ed25519 sig over canonical row by audit-svc HSM key
  ts                timestamptz
)
```

### 8.2 Pipeline

- Written transactionally with the business mutation (outbox pattern); audit-svc signs asynchronously within 5s.
- Mirrored to **S3 Object Lock (WORM, compliance mode, 7-year retention)**.
- Daily **Merkle root** of all signed rows posted to an internal append-only ledger (separate AWS account, separate KMS key); root + previous-day hash chained - tamper-evident.
- SMB owner gets a **self-serve audit explorer** (read-only, filterable, exportable as signed PDF).

### 8.3 Compliance mapping

| Control | Field(s) | Framework |
|---|---|---|
| Non-repudiation of payment | `mfa_evidence`, `signature`, `actor.dev_id` | RBI, DPDP, SOC-2 CC7 |
| Right-to-explanation | `justification_run_id` | GDPR Art 22 / DPDP §11 |
| Access logging | every row with `action like '%.read'` for P0/P1 detokenize | SOC-2 CC6 |
| Tamper-evidence | `signature`, daily Merkle root | SOC-2 CC7.2 |
| Data subject access | filter by `business_id`, export | GDPR Art 15, DPDP §11 |

Residual: audit-svc HSM key compromise - mitigated by dual-control rotation and ledger-side anchoring on a separate AWS account.

---

## 9. Data residency and regulatory compliance

| Region | Framework | Where data lives | Special obligations |
|---|---|---|---|
| India | **RBI data localization**, DPDP 2023, RBI AA framework, GST/Income-Tax Act | `ap-south-1` (Mumbai); DR `ap-south-2` (Hyderabad). Payment data per RBI: storage in India, with foreign payment-leg data permitted for cross-border only | Consent registry per DPDP §6; purpose limitation; data principal rights workflow with 30-day SLA; AA consent artifact with `purpose_code`/`expiry`/`frequency`; AA FI data purged at consent expiry |
| EU | GDPR | `eu-central-1` (Frankfurt); DR `eu-west-1` | DPO contact in app; right-to-erasure with audit-trail retention exception documented; SCC for any sub-processor outside EU |
| US | SOC-2 Type II, CCPA | `us-east-1`; DR `us-west-2` | "Do not sell" honored; annual SOC-2 audit; sub-processor list public |

### 9.1 Residency enforcement

- Tenant pinned to home region at signup; resource ARNs region-scoped; **router refuses cross-region calls for P1/P0 data**.
- A *region sentinel test* runs in CI: every request handler is annotated with a region budget; calls outside budget fail the test.
- Backups stay in-region; cross-region replication only for billing/auth control-plane (no P0/P1).

### 9.2 Erasure

- **DPDP / GDPR erasure** = (a) destroy the tenant DEK (instant cryptographic erasure of P1/P2), (b) tombstone audit rows are *retained* under regulatory exception, with the row's `actor` and content fields scrubbed but the action-graph preserved, (c) vector-store namespace dropped, (d) Vault tenant path deleted, (e) provider-side AA / bank tokens revoked.
- SLA: 30 days; actually executed in <72h.

### 9.3 PAN / Aadhaar / GST

- PAN - tokenized; raw value only retrievable inside detokenize service with audited reason code.
- Aadhaar - never stored unless Aadhaar-based KYC; stored in HSM-vault as hashed + last-4; raw discarded post-verification.
- GST data - encrypted P1; GSTIN tokenized for joins.

---

## 10. Code execution and supply chain

| Surface | Trust | Control |
|---|---|---|
| Forecast engine | Trusted internal code only - no user-supplied code path | Normal pod; standard limits |
| OCR / PDF parsing | **Untrusted** PDFs from invoice email, bank statement uploads | gVisor + read-only root FS + no egress + seccomp + 256MB / 30s CPU / 10MB output cap; same isolation discipline as the BlackBox WASM sandbox plane built for 1M+/day executions (`resume.txt L49-50`, `blackbox-experience.md #3-5`) |
| Agent tool calls | Tools are first-party adapters - no arbitrary code | Capability allow-list at tool gateway (see `15-guardrails.md`); per-tool circuit breaker; idempotency keys |
| LLM-generated SQL / code | If ever exposed (e.g. ad-hoc analytics) | Routed through the WASM sandbox plane (same pattern), read-only DB role, query-cost budget, EXPLAIN-gate |

**CI/CD supply chain** (the standardized model from Microsoft, `resume.txt L93-94`, `microsoft-experience.md #17`):

- **CodeQL** on every PR - taint analysis tuned for SQL injection, SSRF, deserialization, secrets-in-logs.
- **GitHub Advanced Security** - secret scanning, dependency review, Dependabot for high CVEs (block release).
- **Snyk SCA** - container + dependency scan; high CVE blocks merge; medium opens issue.
- **SBOM** (CycloneDX) per image; published; signed.
- **Image signing** - cosign with CloudHSM-backed key; **Kyverno admission controller** rejects unsigned images.
- **Reproducible builds** - distroless base, pinned digests, build provenance per SLSA L3.
- **Branch protection** - required reviews from CODEOWNERS, security review required for changes in `services/payments/**`, `services/agent/**`, `services/audit/**`, `iac/**`.

---

## 11. Payment-rail safety controls

These sit *between* the agent and the bank adapter. Same trust boundary as the WASM sandbox plane at BlackBox - assume the layer above can be wrong, and gate at the trust boundary.

| Control | Rule | Bypass / escalation |
|---|---|---|
| Velocity limit per business | Sliding 1h/24h/30d windows; ramp limits for accounts <30 days old (start ₹50k/day, double weekly) | Owner can raise after MFA + 24h cool-off |
| Anomaly detection | ML model on payment patterns (amount, beneficiary novelty, time-of-day, cadence); >3σ deviation triggers HITL even if under MFA threshold | Owner override with reason code, logged |
| Beneficiary allow-list | New beneficiary requires 24h cool-off before first payment > ₹10k | Manual escalation via support, requires video-KYC of owner |
| Dual control | Payments > ₹5L require Owner + Accountant approval; both MFA-bound | Single-owner businesses configure a co-signer; sole owner > ₹5L requires biometric + 4h delay |
| Hard daily cap | Default ₹10L per business, configurable up; absolute ceiling ₹50L without manual underwriting | Compliance ticket |
| Time-of-day guard | Payments between 02:00–05:00 IST require fresh MFA + reason code | – |
| Recipient sanity | Cross-check beneficiary IFSC + name against NPCI name-match before initiating; mismatch blocks send | Owner override with explicit acknowledgment |
| Circuit breaker | Bank-adapter error rate > 5% / 5 min freezes new payments to that bank; existing in-flight unaffected | Auto-recover when rate < 1% for 10 min; pageable |

These controls run *in front of* the bank adapter, not inside the agent - assumes agent layer can be wrong (prompt injection, model regression). Cross-reference `15-guardrails.md` for the agent-side counterparts.

---

## 12. Incident response

Runbooks per incident class. Each has owner, paging rules, containment SLA, customer-notification SLA, forensic checklist.

| Class | Owner | Containment SLA | Notification SLA | Forensic artifacts |
|---|---|---|---|---|
| Provider creds leaked | SecOps + on-call | 15 min revoke | 24h customer notice if data accessed (DPDP/GDPR) | Vault audit log, NetworkFlow logs, S3 access logs |
| Payment misroute / wrong beneficiary | Payments on-call + SecOps | 30 min - initiate recall via bank API | Same-day to affected SMB | Audit row, justification_run_id, agent trace |
| Cross-tenant data bleed | SecOps lead + CTO | 1 hr - feature-flag off, drain cache, redact logs | 72h to all potentially affected tenants (DPDP) | RLS sentinel results, cache key dump, span trace |
| Prompt-injection chain leading to payout | SecOps + Agent on-call | 1 hr - kill switch on relevant tool capability | 72h customer notice | Full agent run replay (see below); injected content snapshot |
| GDPR / DPDP data subject request | Privacy lead | 30 day SLA / 72h in practice | per regulation | Erasure log, DEK destruction proof, vector-store namespace delete |
| RBI inspection | Compliance lead + CTO | n/a (cooperative) | per regulator | Audit-log extracts, signed exports, Merkle root verification |

**Paging:** P0 pages on-call engineer + security on-call + compliance lead; PagerDuty escalation 5 min; war-room auto-opens (Slack channel + Zoom bridge).

**Forensics-ready posture:**

- Read-only IAM role `forensic-investigator` with audit-only access, MFA-gated, just-in-time provisioned via Vault.
- All logs immutable (S3 Object Lock, CloudWatch log groups with delete-protection).
- **Deterministic agent replay** for any `run_id` - same pattern that cut org-wide MTTR for AI logic anomalies by 60% at BlackBox (`resume.txt L58-59`, `blackbox-experience.md #20`). Reduces RCA on a prompt-injection or tool-abuse incident from days to hours.
- Quarterly tabletop exercise covering at least one runbook per class.

Residual: notification SLA assumes detection - see §13 on detection coverage.

---

## 13. Red-team and continuous validation

| Activity | Cadence | Scope | Owner |
|---|---|---|---|
| External pentest | Quarterly | App, API, mobile, infra (rotating focus); SOC-2 evidence | Third-party firm |
| Internal red-team - classic | Monthly | Auth, RBAC bypass, IDOR, SSRF, secrets exfil | SecOps |
| Internal red-team - **agentic surface** | Monthly | Prompt-injection chains, tool-call abuse, capability-escalation across nodes, memory poisoning via ingestion (see `15-guardrails.md` for behavioral counterparts); cross-tenant bleed via vector store | SecOps + Agent team |
| Sentinel-row drill | Weekly | Insert tenant-A sentinel into every shared store; assert zero retrieval from tenant B path | Platform |
| Chaos-security drill | Monthly | Inject expired JWT, expired SPIFFE SVID, revoked AA consent - verify all hops fail closed | Platform |
| Dependency / image scan | Per build | CodeQL, Snyk, cosign verify | CI |
| Threat-model refresh | Per major feature | New surface added to STRIDE; design review signed by security | Architect + SecOps - same governance pattern as the 30+ architecture reviews and standardized threat modeling at Microsoft (`resume.txt L93-96`, `microsoft-experience.md #18-19`) |
| Compliance evidence collection | Continuous (drata-style) | SOC-2, DPDP, GDPR control evidence auto-collected from CI, IAM, Vault, KMS | Compliance |
| Bug bounty | Continuous | Public scope: web/API; private scope: agent tools, payment rails | SecOps |

Residual: red-team coverage of the agentic surface is *new ground* for the industry - we expect to discover unknown-unknown chains, which is why incident response (§12) is built around deterministic replay rather than around assuming we will detect every novel chain at first occurrence.

---

## Cross-references

- `03-architecture.md` - LB topology, NLB EIPs, regional routing.
- `15-guardrails.md` - prompt-injection defense, tool-gateway capability ACL, output content safety, memory-poisoning behavioral controls.
- `22-ingestion-pipeline.md` - embedding manifest signing and ingestion provenance (if present in pack).
- `19-agentic-graph-structure.md` - node capability declarations consumed by §3 ABAC and §11 payment-rail gates.

## Confidence and assumptions

- **High confidence**: STRIDE coverage, identity/auth choices, encryption tiers, audit-log design, supply-chain (direct anchors at Microsoft and BlackBox).
- **Medium confidence**: exact bank-side webhook capabilities and IP-allow-list discipline vary per Indian PSU bank; the per-bank adapter abstracts this but real numbers will shift on integration. Assumed: NPCI name-match API availability for §11.
- **Assumptions**: RBI does not further tighten cross-border AA data movement during build; CloudHSM in `ap-south-1` meets RBI HSM expectations for the payment-signing key (validated with banking partner before GA).
