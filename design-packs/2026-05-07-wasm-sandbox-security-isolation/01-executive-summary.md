# Executive Summary

## Seven-Layer Defense-in-Depth Stack

**The one-sentence principal answer:** Preventing malicious AI-generated code from abusing the sandbox requires five independent enforcement layers - WASM runtime controls, WASI capability restrictions, OS-level isolation (seccomp + cgroups + namespaces), Kubernetes pod security, and multi-tenant pool separation - so that bypassing any one layer does not result in a breach.

---

### Layer 1 - WASM as the First Isolation Boundary

WASM's linear memory model bounds all pointer arithmetic to offsets within the module's own allocated region - code cannot reference the host Go process heap or another module's memory. WASM bytecode has no `syscall` instruction; every host interaction must go through an explicitly imported WASI host function. The Go host registers only an approved allowlist (stdout, stderr, clock); filesystem, network, and environment access are denied at import resolution - the module traps before it can call them.

### Layer 2 - CPU: Instruction Metering (Fuel)

Wall-clock timeout (`context.WithTimeout`, e.g., 30s) handles I/O-bound denial-of-service. Fuel metering (`store.SetFuel(maxFuel)` in Wasmtime) decrements a counter per WASM instruction - when it hits zero the runtime traps with `OutOfFuel`, hard-capping CPU regardless of wall-clock behavior. This is the primary CPU kill mechanism and is critical at 1M+ daily executions.

### Layer 3 - Memory: Linear Memory Page Cap

A compile-time ceiling (e.g., 256 pages = 16 MB) is set via `WithMemoryLimitPages(256)`. If the module's declared max exceeds the cap, compilation is rejected before a single byte executes. `memory.grow` beyond the cap traps at runtime. The host Go process heap is never touched by module code.

### Layer 4 - Filesystem: WASI Pre-open Allowlist + Ephemeral-Only

`FSConfig` starts empty (no mounts). When file I/O is required, an ephemeral `/tmp/exec-{uuid4}/` directory is created, mounted as the WASM filesystem root, and `defer os.RemoveAll(tempDir)` unconditionally wipes it before the result is returned - even on panic. `open("/etc/passwd")` raises `FileNotFoundError` inside the sandbox.

### Layer 5 - Network: Block WASI `sock_*` + OS Network Namespace

WASI socket functions are never registered with the runtime - any module expecting socket access fails at instantiation before execution starts. As backstop: each worker runs in a Linux network namespace (`CLONE_NEWNET`) with loopback only and no default gateway. Even `169.254.169.254` (cloud metadata) is unreachable at the kernel level.

### Layer 6 - OS: seccomp-bpf + cgroups v2 + Linux Namespaces

seccomp-bpf allowlist applied once at worker startup: `socket`, `connect`, `execve`, `ptrace`, `mount`, `perf_event_open` blocked - violation → `SIGKILL` instantly. cgroups v2: CPU quota (e.g., 200ms CPU per 1s wall), `memory.max` (256 MB, OOM-kills before affecting neighbors), `pids.max=64` (blocks fork bombs). Linux namespaces: net, pid, mount, user - all isolated.

### Layer 7 - Kubernetes: NetworkPolicy + AppArmor + Pod Security

`NetworkPolicy` denies all egress except the internal metrics endpoint. Pod spec: `runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: ALL`, `allowPrivilegeEscalation: false`, `automountServiceAccountToken: false`. AppArmor profile blocks `ptrace`, `mount`, `net_raw`, `net_admin`.

---

### No Shared State Between Executions

Every execution gets a fresh `InstantiateModule` call. Instances are never reused across executions - not across tenants, not within the same tenant. The compiled module artifact (immutable bytecode) is cached by code hash; only the instance (which holds mutable state) is discarded.

### Multi-Tenant Separation

Free, Pro, and Enterprise tiers run in separate Kubernetes Deployments with separate node selectors. Enterprise tenants can get dedicated nodes. Ephemeral temp dirs are `uuid4`-scoped and wiped immediately. No shared in-process goroutine state between concurrent tenant requests.

### SOC-2 Connection

This stack directly unblocked SOC-2 Type II compliance at BlackBox. Auditors reviewed: WASI `FSConfig` as logical access control evidence, immutable Clickhouse audit log (code hash + tenant ID + timestamp) for non-repudiation, network namespace configuration for confidentiality controls, and the instance-per-execution model for data separation between tenants.
