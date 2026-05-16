# 10 - Interview Cheat Sheet: Sandbox Escape Prevention

Topic: How do you prevent malicious AI-generated code from escaping the sandbox or abusing CPU, memory, filesystem, or network access?

---

## Defense-in-Depth Stack (5 Layers)

- **Layer 1 - WASM capability model:** WASI imports explicitly denied at link time; no socket, filesystem, env var, or process-creation handles granted. If it's not in the import list, it doesn't exist inside the sandbox.
- **Layer 2 - Linear memory isolation:** Each instance gets a fresh, bounded linear memory (128MB cap). `wasm_memory_grow` is intercepted and capped before any OS allocation. Memory freed and reallocated per execution - not reused.
- **Layer 3 - OS process isolation:** Worker process runs in a Linux network namespace (no routes), mount namespace (tmpfs only, noexec/nosuid), non-root UID with no privilege escalation.
- **Layer 4 - Seccomp-BPF:** ~25 syscall allowlist; execve/clone/ptrace/socket blocked; mmap/mprotect allowed only without PROT_EXEC on writable regions (W^X enforcement at kernel level).
- **Layer 5 - Worker lifetime limits:** Worker retired after N executions and T minutes; fresh process replaces it. Blast radius of any single compromise bounded to one worker's execution window.

---

## Fast Answer for "How Do You Prevent Sandbox Escape?"

> "Defense-in-depth across five layers. WASM's capability model means the filesystem and network APIs don't exist inside the sandbox - not blocked, literally absent. If the WASM runtime is bypassed, the worker process is in a network namespace with no routes, a seccomp profile with execve blocked, and a tmpfs mount with nothing on it. A JIT CVE gets the attacker into a dead-end process with no network, no persistence, and no lateral movement surface. We subscribe to Wasmtime advisories and redeploy within 24 hours of a critical CVE."

---

## CPU Enforcement

- **Primary control:** Fuel metering - per-instruction token budget; synchronous trap when exhausted; instant kill, no scheduling delay.
- **Secondary control:** Wall-clock deadline via host goroutine context cancellation - catches fuel calibration gaps.
- **Tertiary control:** cgroup `cpu.max` at the worker process level - kernel-enforced ceiling; prevents monopolizing vCPU even if WASM runtime is bypassed.
- **Key distinction:** Fuel is not wall-clock time. Calibrate empirically per language runtime (Python/Pyodide burns fuel orders of magnitude faster per second than compiled Rust WASM).

---

## Memory Enforcement

- **WASM layer:** `WithMemoryLimitPages(2048)` = 128MB cap. `wasm_memory_grow` returns -1 before OS allocation if cap would be exceeded. Python `MemoryError` surfaces inside sandbox; host RSS stays bounded.
- **OS layer:** Kubernetes `resources.limits.memory` on the pod as OOM-kill backstop if runtime itself leaks.
- **Isolation:** Fresh linear memory per execution - `module.Close()` frees prior instance's memory; `InstantiateModule` allocates new memory from module's data segments. No byte reuse between tenants.

---

## Filesystem Enforcement

- **WASI layer:** No preopened directory handles passed to the module. WASM code cannot call `path_open`, `fd_read`, or any file WASI function - they trap as unimplemented.
- **OS layer:** Worker's mount namespace contains only an empty tmpfs (`noexec`, `nosuid`). Even if WASM runtime is compromised, there is no persistent storage to read or write.
- **Prior failure mode (pre-WASM):** subprocess approach failed SOC-2 because `/proc/self/environ` was readable inside the sandbox. WASM/WASI has no `/proc` - the filesystem namespace literally does not exist.

---

## Network Enforcement

- **WASI layer:** No socket import handles granted. `sock_open`, `sock_connect`, `sock_send`, `sock_recv` are refused at module instantiation - attacker cannot call them.
- **OS layer:** Linux network namespace with no routes. Even if a raw socket were opened via a runtime bug, `ENETUNREACH` on every packet. No DNS resolver reachable.
- **Seccomp layer:** `socket(2)` syscall blocked. Belt-and-suspenders at three independent layers.

---

## Multi-Tenant Isolation

- **Memory:** Separate linear memory per instance, freshly allocated. WASM specification guarantees no cross-instance memory access - formally verified property, not runtime configuration.
- **CPU:** Temporal isolation - one worker, one execution at a time. Tenants interleave across scheduling quanta but not simultaneously on one core.
- **Temporal:** Worker processes retired after N executions. Compromised worker cannot observe future tenants' executions.
- **Enterprise tier:** Dedicated worker node pools per tenant for Spectre/cache side-channel sensitive workloads (separate physical nodes, not just namespaces).

---

## SOC-2 Relevant Controls

- WASI capability model maps directly to "least privilege" - demonstrable to auditors as "the API does not exist" rather than "the API is blocked by policy."
- Isolation test suite (24-hour sentinel-value cross-read test) run in staging and presented as audit evidence.
- Execution audit log (code hash, tenant ID, timestamp, exit status) in append-only Clickhouse table for compliance trail.
- Worker lifetime limits and fresh-instance semantics documented as controls for "data remanence" SOC-2 criterion.
- Seccomp and namespace configuration exported as machine-readable policy, diffed on every deploy, reviewed in change management.

---

## Key Tradeoff (WASM vs Docker / gVisor / Firecracker)

| | WASM | Docker | gVisor | Firecracker |
|---|---|---|---|---|
| Per-exec dispatch (pre-pulled, fresh sandbox) | <10ms (warm pool) | 50–300ms (runc) | 100–500ms | 125ms (snapshotted) |
| Memory overhead | ~5MB | ~50MB | ~100MB | ~50MB (kernel) |
| Isolation model | Capability (formal spec) | Namespace + seccomp | Userspace kernel | Hardware VM |
| Shared kernel | No (WASM is userspace) | Yes (biggest risk) | No | No |
| Language agnostic | Yes | Yes | Yes | Yes |
| 1M+/day at <10ms | Yes | No | No | No |

**One-line answer:** Only WASM delivers sub-10ms warm dispatch, language-agnostic isolation, and a formally-specified capability model simultaneously. Everything else makes the wrong tradeoff for AI zero-shot code execution at this operating point.

---

## Fuel Metering vs cgroups

- **Fuel:** Per-instruction, instant kill, no kernel overhead, not wall-clock - use as primary in-WASM control.
- **cgroup:** Wall-clock accurate, kernel-enforced, ~10ms granularity, throttles not kills - use as backstop at process level.
- **Together:** Fuel catches normal CPU exhaustion fast; cgroup catches JIT bypass or mis-calibrated fuel budgets at the OS level.

---

## Two Resume Anchors to Name-Drop

1. **BlackBox - WASM sandbox plane:** "I architected the isolation layer that ran 1M+ daily zero-shot code executions and was the specific control that unblocked our Enterprise SOC-2 certification. The prior subprocess approach failed the SOC-2 audit; WASM's capability model passed."
2. **Microsoft - threat modeling standardization:** "At Microsoft, I standardized threat modeling across security-critical systems and mentored 8 engineers on secure protocol design. I bring that STRIDE-first discipline here - the blast-radius bounding on worker compromise and the five-layer defense-in-depth stack are direct outputs of that methodology."

---

## The One Sentence That Shows Principal-Level Thinking

> "I don't design for the happy path - I define the blast radius of every component's worst-case failure before it's deployed, then prove the blast radius is acceptable to the business, the auditors, and the tenants who depend on isolation holding."
