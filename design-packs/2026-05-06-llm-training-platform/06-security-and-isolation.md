# 06 - Security and Isolation

## 1. Threat Model Overview

### Assets

| Asset | Sensitivity | Why it matters |
|---|---|---|
| Customer training data (ADLS Gen2 / Blob) | Critical | Customer-owned; breach = contractual and regulatory failure |
| Fine-tuned model weights (checkpoints, artifacts) | Critical | Customer IP; exfiltration or poisoning is catastrophic |
| Customer training code (scripts, notebooks) | High | May embed secrets; can be weaponized if run in wrong namespace |
| Platform secrets (service principals, signing keys, infra creds) | Critical | Compromise allows pivot to all tenants |
| GPU cluster capacity | High | DoS target; over-provisioning harms revenue |
| Job metadata and logs | Medium-High | May contain data samples, hyperparams, model architecture |
| Base container images | High | Supply-chain entry point |

### Threat Actors

| Actor | Capability | Primary concern |
|---|---|---|
| External attacker | Unauthenticated, probes public endpoints | Data exfiltration via misconfigured storage or leaked SAS tokens |
| Malicious tenant | Authenticated, submits crafted jobs | Cross-tenant data access; resource exhaustion; GPU memory scraping |
| Compromised pod | Attacker-controlled code inside training container | SSRF to IMDS; lateral movement via cluster network; secret scraping |
| Supply chain attacker | Injects malicious pip/base-image dependency | Code execution inside training container with GPU and network access |
| Malicious insider (Microsoft operator) | Elevated Azure RBAC | Access to customer storage or model weights without tenant knowledge |

### Trust Boundaries

```
[Internet / Customer SDK / Azure Portal]
         ↓  TLS 1.3 + Azure AD OIDC
[Platform Control Plane - API Gateway]
         ↓  Managed Identity + RBAC
[Kubernetes Scheduler + Volcano]
         ↓  Namespace boundary + NetworkPolicy (deny-all)
[Training Pod - customer code + platform base image]
         ↓  Managed Identity delegation / scoped SAS token
[Customer Storage (ADLS Gen2 / Blob) + Key Vault]
```

---

## 2. STRIDE Analysis - Top 3 Trust Boundaries

### Boundary A: Internet → Control Plane API

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | Attacker impersonates customer to submit jobs | Azure AD OIDC; short-lived access tokens (1h TTL) |
| **T**ampering | Job spec modified in transit | TLS 1.3 end-to-end; payload hash in idempotency key |
| **R**epudiation | Customer denies submitting a job | Immutable Azure Activity Log + platform audit log (WORM) |
| **I**nformation Disclosure | API response leaks other tenant's job | Tenant ID enforced as partition key; row-level auth on all DB queries |
| **D**oS | Job submission flood exhausts scheduler | Per-workspace token bucket rate limiting; admission webhook rejects over-quota |
| **E**levation | Workspace A's token accepted by workspace B | Workspace ID validated against token audience claim; separate RBAC scopes |

### Boundary B: Training Pod → Customer Storage

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | Pod presents fabricated identity to storage | Managed Identity token verified cryptographically by Azure AD |
| **T**ampering | Training data modified in transit | TLS 1.3 enforced; read-only SAS or `Storage Blob Data Reader` role |
| **R**epudiation | Dispute over which data version was used | Azure Storage diagnostic logs record every read; job metadata records exact Blob URI + ETag |
| **I**nformation Disclosure | Pod reads another tenant's Blob container | SAS scoped to customer's specific container prefix only |
| **D**oS | Runaway pod exhausts storage throughput | Storage account throttling; LimitRange caps concurrent reader threads per pod |
| **E**levation | Pod writes to source data container | Source data SAS is read-only; write target is a separate, platform-controlled staging container |

### Boundary C: Pod-to-Pod (TunDRA / QUIC)

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | Rogue node claims to be a legitimate worker | mTLS via QUIC; each compute instance has unique cert from platform CA |
| **T**ampering | Gradient data modified in transit | QUIC stream integrity via AEAD (AES-128-GCM); bit flip causes stream failure |
| **R**epudiation | Worker denies sending corrupted gradient | TunDRA logs stream-level sequence numbers and HMAC per payload segment |
| **I**nformation Disclosure | Tenant A's pod intercepts tenant B's gradient | NetworkPolicy + subnet isolation: cross-tenant pod IPs unreachable |
| **D**oS | Malicious node floods NCCL channel | Per-connection rate limits in TunDRA Rust layer; QUIC flow control prevents memory exhaustion |
| **E**levation | Compromised worker impersonates scheduler | Scheduler uses separate mTLS channel; worker certs have no cluster-admin RBAC binding |

---

## 3. Network Isolation

### VNet Architecture

```
Microsoft Platform VNet (10.0.0.0/16)
├── Control Plane Subnet (10.0.1.0/24)
│   ├── API Gateway
│   ├── Job Service
│   └── Scheduler Adapter
│
├── Platform Services Subnet (10.0.2.0/24)
│   ├── Container Registry (ACR) private endpoint
│   ├── Key Vault private endpoint
│   └── Monitoring endpoints
│
└── AKS Node Pool Subnet (10.0.16.0/20) [platform system nodes]

Customer VNet A (10.10.0.0/16) [peered to platform VNet]
├── Training Pods Subnet (10.10.1.0/24) [tenant-xyz namespace]
│   └── Private Endpoints → Customer ADLS Gen2
│
Customer VNet B (10.11.0.0/16) [peered to platform VNet]
└── Training Pods Subnet (10.11.1.0/24) [tenant-abc namespace]
    └── Private Endpoints → Customer ADLS Gen2
```

> **Assumption:** Each enterprise tenant gets a dedicated VNet peering to the platform VNet. Smaller tenants share a platform-managed VNet with namespace-level NetworkPolicy isolation.

**Why VNet peering instead of shared VNet?** Peering creates a hard network boundary - no route exists between tenant A's subnet and tenant B's subnet. Namespace-level NetworkPolicy within a shared VNet is software-enforced and has a larger blast radius if misconfigured.

### NSG Rules (per tenant subnet)

| Priority | Direction | Source | Destination | Port | Action |
|---|---|---|---|---|---|
| 100 | Inbound | Same-subnet (NCCL workers) | Same-subnet | TCP/29500 | Allow |
| 110 | Inbound | Platform control plane | Tenant subnet | TCP/443 | Allow |
| 900 | Inbound | Any | Any | Any | Deny |
| 100 | Outbound | Tenant subnet | Customer ADLS private endpoint | TCP/443 | Allow |
| 110 | Outbound | Tenant subnet | ACR private endpoint | TCP/443 | Allow |
| 120 | Outbound | Tenant subnet | Key Vault private endpoint | TCP/443 | Allow |
| 130 | Outbound | Tenant subnet | Azure Monitor private endpoint | TCP/443 | Allow |
| 900 | Outbound | Any | Internet | Any | Deny |

The deny-all internet egress is critical: it prevents exfiltration of model weights or training data.

### Kubernetes NetworkPolicy

```yaml
# Default deny-all for tenant namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: tenant-xyz
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# Allow NCCL between workers in same job
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-nccl-intra-job
  namespace: tenant-xyz
spec:
  podSelector:
    matchLabels:
      job-id: "jb-abc123"
  ingress:
    - from:
        - podSelector:
            matchLabels:
              job-id: "jb-abc123"
      ports:
        - port: 29500
---
# Allow egress to private endpoints only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-egress-private-endpoints
  namespace: tenant-xyz
spec:
  podSelector: {}
  egress:
    - to:
        - ipBlock:
            cidr: 10.10.2.0/24  # private endpoint subnet
      ports:
        - port: 443
```

---

## 4. Identity and Authentication

### Managed Identity for Pods (Workload Identity Federation)

Each training job gets a **per-job Managed Identity** (or uses a per-tenant Managed Identity with scoped RBAC). No long-lived credentials are stored anywhere.

Flow:
1. Pod Launcher annotates pod spec with `azure.workload.identity/client-id: <mi-client-id>`.
2. AKS OIDC issuer issues a projected service account token.
3. Pod exchanges OIDC token for an Azure AD access token via `DefaultAzureCredential`.
4. Azure Storage validates the token signature + claims.

**Key property:** The Managed Identity's RBAC is scoped to exactly the customer's storage container. It has no access to other tenants' storage. It cannot read its own Key Vault secrets - those are injected at pod start via CSI driver before training code starts.

### Token Refresh

Access tokens expire in 1 hour. Long-running training jobs (multi-day runs) need automatic token refresh. The Azure SDK handles this transparently via `DefaultAzureCredential` with exponential backoff on 401 responses.

---

## 5. Secrets Management

**Rule: no secrets in environment variables, no secrets in container images.**

### Key Vault CSI Driver

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: job-secrets
  namespace: tenant-xyz
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "true"
    userAssignedIdentityID: "<mi-client-id>"
    keyvaultName: "platform-kv"
    objects: |
      array:
        - |
          objectName: dataset-sas-token
          objectType: secret
          objectVersion: ""
  secretObjects:
    - secretName: job-secrets
      type: Opaque
      data:
        - objectName: dataset-sas-token
          key: DATASET_SAS
```

Secrets are mounted as files at `/mnt/secrets/`. Training code reads them at runtime. They are never in the pod's `env` block.

**Certificate rotation:** Key Vault certificates are rotated every 90 days. Rotation is zero-downtime: new version is pre-staged, CSI driver hot-reloads on next volume remount, TunDRA uses certificate reloading at connection establishment.

---

## 6. Training Code Isolation

Customer training code runs with:
- **No privileged mode** (`securityContext.privileged: false`)
- **Read-only root filesystem** where possible (writable only for `/tmp`, `/mnt/checkpoints`)
- **Dropped capabilities** (`capabilities.drop: ["ALL"]`; add back only `NET_BIND_SERVICE` if needed)
- **Non-root user** (`runAsNonRoot: true`, `runAsUser: 1000`)
- **seccomp profile:** RuntimeDefault
- **AppArmor:** `runtime/default` annotation

```yaml
securityContext:
  privileged: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  runAsUser: 1000
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

> **Assumption:** GPU workloads require `nvidia.com/gpu` resource but not privileged mode. The NVIDIA device plugin handles this without privileged containers on AKS.

---

## 7. Secure Data Access Pattern

```
Customer ADLS Gen2 ──────────────────────────────────────────┐
(stays in customer's Azure subscription)                      │
                                                               │
                         Private Endpoint                      │
Training Pod ──── Managed Identity token ──► Azure AD ──► ADLS │
                                                               │
No data copy to Microsoft-owned storage.                       │
Platform only reads during training; writes go to a           │
separate, platform-controlled artifact staging container.      │
└──────────────────────────────────────────────────────────────┘
```

**Why no data copy?** Enterprise customers with data sovereignty requirements (EU GDPR, HIPAA, FedRAMP) cannot allow their training data to move to Microsoft-owned storage. The private endpoint model keeps data in the customer's subscription and Azure region while still enabling compute access.

---

## 8. Checkpoint and Artifact Security

| Layer | Control |
|---|---|
| Encryption at rest | Azure Storage Service Encryption (SSE) with customer-managed keys (CMK) via Key Vault |
| Encryption in transit | TLS 1.3 + TunDRA QUIC AEAD |
| Access control | Checkpoint container: write access only from training pod's Managed Identity; read access from CheckpointManager and ArtifactPublisher service identities |
| Artifact container | Write access only from ArtifactPublisher service identity; read access scoped per customer workspace |
| Integrity | Each checkpoint's SHA-256 hash stored in manifest.json; verified before model load on retry or deployment |

---

## 9. Secure CI/CD (Platform's Own Build Pipeline)

Resume anchor: *"Integrated CodeQL and GitHub Advanced Security into CI/CD pipelines; standardized threat modeling."*

Controls implemented:
- **CodeQL static analysis** on all Go (control plane services) and Python (training harness) PRs. Blocks merge on high/critical severity findings.
- **GitHub Advanced Security** dependency scanning: CVE alerts on pip and Go module graphs.
- **Container image scanning:** Trivy runs on every image build; no HIGH+ CVE images pushed to ACR.
- **Distroless base images** for all platform services: minimal attack surface, no shell, no package manager.
- **SBOM generation** for every release: `syft` generates CycloneDX SBOM, stored in ACR with the image.
- **Threat modeling:** SDL-style threat models for each new platform component; reviewed in 30+ architecture reviews. Tracked in ADO with mitigations mapped to work items.

---

## 10. TunDRA: Why QUIC Instead of TCP+TLS

Resume anchor: *"Co-developed TunDRA, a secure QUIC-based communication protocol in Rust powering over 1 million Compute Instances with 50% improvement in secure data transfer."*

| Property | TCP + TLS 1.3 | QUIC (TunDRA) |
|---|---|---|
| Connection setup | 3-way TCP handshake + TLS handshake = 2 RTTs | 0-RTT resumption with TLS 1.3 session tickets |
| Head-of-line blocking | Yes - all streams stall on one lost packet | No - independent QUIC streams; one loss only stalls that stream |
| Connection migration | No - IP change = new TCP connection | Yes - QUIC connection ID survives IP change (pod restart, NAT rebind) |
| Multiplexing | Requires multiple TCP sockets | Single QUIC connection, multiple streams |
| Congestion control | Kernel TCP (CUBIC/BBR) | Pluggable per connection (BBR tuned for data center) |
| Implementation language | Kernel-space (OS handles) | User-space Rust - custom congestion, custom flow control |

**The 50% improvement** was in secure data transfer throughput, primarily from:
1. 0-RTT connection resumption reducing setup overhead for short-lived checkpoint uploads
2. No head-of-line blocking enabling concurrent checkpoint-upload streams without stalling
3. User-space BBR congestion control tuned for Azure's flat data center network

---

## 11. Compliance Gates

Before any job runs:
1. Admission webhook validates tenant quota and dataset URI access
2. Pod Launcher verifies container image SHA is in ACR allowlist (no untrusted external images)
3. SecurityContext policy admission controller enforces pod security standards

Before a model is published:
1. Eval harness passes BLEU/MMLU thresholds
2. ArtifactPublisher verifies artifact SHA matches final checkpoint hash
3. Compliance tag (`data_classification`, `tenant_id`, `training_data_uri`) written to MLflow model metadata

Before a new platform version deploys:
1. CodeQL + Trivy gates pass
2. Threat model sign-off for any new trust boundary or network path
3. Staged rollout: canary region → 10% → 50% → 100% with automated rollback on error rate spike
