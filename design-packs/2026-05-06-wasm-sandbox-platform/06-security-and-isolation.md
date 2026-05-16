# 06 - Security and Isolation

## Why WASM for SOC-2 Compliance

Resume anchor: *"unblocking Enterprise SOC-2 compliance for the core Copilot product."*

SOC-2 Type II requires demonstrable controls for:

| SOC-2 Control | Platform requirement | WASM mechanism |
|---|---|---|
| **Logical access control** | No cross-tenant execution data leakage | WASM linear memory is per-instance; discarded after each execution |
| **Change management** | Audit trail for all code executions | OTel span per execution → Clickhouse |
| **Risk assessment** | LLM-generated code cannot exfiltrate data | WASI capability model: no network, no filesystem by default |
| **Availability** | Execution infrastructure is resilient | Worker crash → automatic retry; pre-warm pool provides fault tolerance |
| **Confidentiality** | Tenant code cannot read other tenants' code or outputs | Complete isolation between worker instances |

The reason WASM specifically unblocked SOC-2 (vs. the prior approach, which was likely containerization or subprocess-based execution): WASM's capability model gives auditors a demonstrable technical control with a much smaller "could this be misconfigured?" attack surface than Docker container isolation.

---

## Threat Model

### Assets

| Asset | Sensitivity | Protection requirement |
|---|---|---|
| Tenant code (submitted for execution) | Medium | Code itself is user's IP; shouldn't be readable by other tenants |
| Execution stdout/stderr | Medium-High | May contain sensitive computed values, API responses |
| Host environment variables | Critical | Cloud credentials, API keys in the worker process environment |
| Other tenants' execution memory | Critical | Cross-tenant data leakage = SOC-2 violation |
| Platform infrastructure (Redis, Clickhouse) | High | If WASM escapes, it could reach internal services |
| WASM module bytecode (Pyodide, QuickJS) | Low | Platform code; not secret, but integrity matters |

### Threat Actors

| Actor | Capability | Primary threat |
|---|---|---|
| Malicious user | Submits crafted code to escape sandbox | WASM escape, host memory read, network egress |
| Curious user | Submits code to read other users' outputs | Cross-execution state leakage |
| LLM-generated malicious code | LLM "jailbroken" to generate attack code | Same as malicious user; sandbox is the mitigation |
| Compromised worker process | Worker process itself is compromised | Lateral movement to Redis, internal services |

---

## STRIDE Analysis

### Trust Boundary 1: Client → API Server

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | Forged tenant JWT | JWT signature verification (RS256); short TTL (1h); audience claim validated |
| **T**ampering | Code payload modified in transit | TLS 1.3 end-to-end |
| **R**epudiation | Tenant denies submitting execution | Audit log with `code_hash`, `tenant_id`, `timestamp`, immutable Clickhouse record |
| **I**nformation Disclosure | Execution result returned to wrong tenant | Execution ID scoped to `(tenant_id, execution_id)`; result lookup validates both |
| **D**oS | Burst of executions exhausts worker pool | Token bucket rate limiting; queue depth cap; 503 with `retry_after` |
| **E**levation | Free-tier user submits enterprise-tier job | Tier limits enforced in Request Validator; JWT claims include tier |

### Trust Boundary 2: Worker Process → WASM Module

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | WASM module claims to be a different language runtime | Module bytecode hash verified against known-good Pyodide/QuickJS hashes at worker startup |
| **T**ampering | Attacker modifies WASM module in object storage | SHA-256 hash of WASM bytecode verified before each `CompileModule`; object storage versioned |
| **R**epudiation | Cannot determine which code caused a crash | `code_hash` stored in execution record; maps to exact code |
| **I**nformation Disclosure | WASM reads host environment variables | WASI: no env vars exposed by default; `WithEnv()` only called with explicit allowlist (currently empty) |
| **D**oS | Malicious code triggers infinite loop, consumes all CPU | `context.WithTimeout` cancel; wazero respects context cancellation and terminates execution |
| **E**levation | WASM code breaks out of sandbox and accesses host memory | WASM memory model prevents this by design; no pointer arithmetic to host addresses |

### Trust Boundary 3: Worker Process → Internal Services (Redis, Clickhouse)

| STRIDE | Threat | Mitigation |
|---|---|---|
| **S**poofing | WASM-generated code connects to Redis and issues commands | WASI has no network APIs exposed; no socket syscalls available inside WASM |
| **T**ampering | Compromised worker modifies other tenants' execution records | Redis key scoped to `execution:{execution_id}`; execution_id is UUID4 (unguessable); TLS to Redis |
| **I**nformation Disclosure | Worker reads other workers' Redis keys | Workers only read/write keys they created; no wildcard key access |
| **E**levation | Worker process granted excessive Redis permissions | Redis ACLs: workers have `SET/GET/HSET/HGET` only on `execution:*` namespace; no `KEYS`, no `CONFIG` |

---

## WASI Capability Configuration (The Core Isolation Layer)

WASI (WebAssembly System Interface) is a capability-based security model. A WASM module can only access the resources explicitly granted through the WASI configuration. Our configuration is intentionally minimal:

```go
func (w *Worker) buildWASIConfig(req *ExecutionRequest) wazero.ModuleConfig {
    return wazero.NewModuleConfig().
        WithStdin(strings.NewReader(req.StdinData)).   // controlled input
        WithStdout(stdoutWriter).                        // captured output
        WithStderr(stderrWriter).                        // captured output
        // NO filesystem mounts - FSConfig is empty
        WithFSConfig(wazero.NewFSConfig()).
        // NO environment variables by default
        // (only explicit allowlist entries, currently none for user code)
        // NO network sockets (WASI preview1 has no socket API; WASI preview2 sockets are not enabled)
        // NO process spawning (no WASI process APIs exposed)
        // Clock access: allowed (needed for datetime operations in Python)
        WithSysWalltime().
        WithSysNanosleep()
}
```

**What this means in practice:**
- `open("/etc/passwd")` → trap: no filesystem access
- `socket(AF_INET, ...)` → trap: no socket API exposed
- `exec("bash", ...)` → trap: no process spawning
- `getenv("OPENAI_API_KEY")` → empty string: env vars not exposed
- `print("hello")` → works: stdout is the only allowed output channel
- `import os; os.environ` → empty dict: env not propagated into Python

---

## Defense in Depth: Layers

Even with WASM's strong isolation, we add additional layers:

### Layer 1: WASM Sandbox (primary)
WASI capability model, memory isolation, CPU timeout, memory limit.

### Layer 2: Linux Namespaces on Worker Process (defense in depth)
> **Assumption:** Worker processes run in Linux network namespaces with `CLONE_NEWNET`. Even if WASM escape occurred (theoretical), the worker process cannot reach the internet or internal services because it's in an isolated network namespace.

```
Worker process namespace:
  Network: isolated (CLONE_NEWNET) - no default routes
  PID: shared with host (workers are not PID-namespaced, for simplicity)
  Mount: shared with host (WASM already prevents filesystem access)
```

### Layer 3: Kubernetes Pod Security
Workers run in Kubernetes pods with:
- `securityContext.runAsNonRoot: true`
- `capabilities.drop: ["ALL"]`
- `readOnlyRootFilesystem: true`
- No service account token mounted (`automountServiceAccountToken: false`)

### Layer 4: No Service Account in Worker Pods
Worker pods have no Kubernetes service account. They cannot query the Kubernetes API, read secrets from etcd, or enumerate other pods. This limits the blast radius of a compromised worker.

### Layer 5: Resource Limits at Pod Level
Even if WASM runtime resource limits fail, the pod-level `resources.limits.memory` and CPU throttling provide a fallback. A worker that exceeds its pod limit is OOM-killed and restarted.

---

## Memory Isolation Between Executions

This is the most frequently tested question in SOC-2 audits: **"How do you ensure one customer's execution cannot read another customer's data?"**

The answer has three components:

1. **WASM instance isolation:** Each execution gets a new module instance with its own linear memory. WASM code can only address offsets within its own linear memory - there is no WASM instruction that can reference host memory or another module's linear memory.

2. **No module instance reuse:** We discard the module instance after each execution (call `module.Close(ctx)`). This frees the WASM linear memory. We do not reuse module instances across executions from different tenants (or even the same tenant), eliminating any risk of one execution reading the previous execution's heap state.

3. **Go garbage collection:** After `module.Close()`, the WASM linear memory backing array is eligible for Go GC. We do not explicitly `memset` zero the memory (Go's GC and WASM runtime handle cleanup), but even if GC has not yet run, the next execution cannot access the freed memory because it gets a new module instance with a new memory allocation.

---

## Secrets Leakage Prevention

The most dangerous threat in an AI code execution platform: LLM-generated code that intentionally tries to read environment variables, call metadata endpoints, or probe the network.

**Attempts that are blocked by the WASI configuration:**

```python
# Attempt 1: read environment variables
import os
print(os.environ.get("OPENAI_API_KEY"))
# Result: None (env not exposed)

# Attempt 2: read host files
with open("/etc/hosts") as f:
    print(f.read())
# Result: WASM trap: no filesystem access

# Attempt 3: reach cloud metadata endpoint
import urllib.request
urllib.request.urlopen("http://169.254.169.254/metadata/")
# Result: socket() call not available in WASI preview1; OSError raised in Python

# Attempt 4: probe network
import socket
s = socket.socket()
s.connect(("redis.internal", 6379))
# Result: socket() not available; OSError raised
```

All of these fail at the WASI capability boundary - the Python interpreter calls the underlying OS API, which in WASM execution is intercepted by the WASI host implementation and returns an error (capability not granted).

---

## Code Hash for Audit Trail

The SOC-2 audit log stores `code_hash = sha256(code)`, not the code itself. This provides:
- Proof that a specific code string was executed, without storing potentially sensitive code
- Ability to verify a specific execution if a user provides the original code
- No long-term retention of arbitrary user code in the audit store

For compliance investigations, the user can provide their code, and we verify it matches the stored hash.
