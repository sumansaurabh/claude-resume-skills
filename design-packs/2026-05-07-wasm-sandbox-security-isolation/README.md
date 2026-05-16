# WASM Sandbox Security and Isolation

**Question:** How would you prevent malicious AI-generated code from escaping the sandbox or abusing CPU, memory, filesystem, or network access?

**Archetype:** system-design (security-focused)
**Company:** BlackBox
**Created:** 2026-05-07
**Grounding confidence:** High (2 strong anchors, 2 supporting)

## What This Pack Covers

Defense-in-depth for AI-generated code execution: WASM runtime controls, WASI capability restrictions, OS-level isolation (seccomp-bpf, cgroups v2, Linux namespaces), Kubernetes pod security, and multi-tenant pool separation. Grounds directly in the BlackBox WASM sandbox plane (1M+ daily zero-shot executions, SOC-2 compliance) and Microsoft multi-tenant ML isolation work.

## File Map

| File | Contents |
|------|----------|
| `00-question-and-context.md` | Original question, scope, assumptions, resume anchors |
| `01-executive-summary.md` | Seven-layer defense stack - principal-engineer one-screen answer |
| `02-architecture.md` | End-to-end defense-in-depth architecture with Mermaid diagrams |
| `03-api-and-contracts.md` | Execution API, SandboxConfig struct, SandboxResult, SecurityEvent contracts |
| `04-low-level-design.md` | SandboxManager, WASMInstance, ResourceEnforcer, SeccompFilter, FsGuard, SecurityEventCollector - state machine |
| `05-scaling-and-capacity.md` | Throughput model, fleet sizing, fuel calibration, AOT compilation cache, per-tier quotas |
| `06-security-and-isolation.md` | Full threat model table (10 threats), trust boundaries, identity/access, SOC-2 control mapping |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, OTel span schema, metrics/alerts, incident runbooks |
| `08-tradeoffs-and-alternatives.md` | WASM vs Docker vs gVisor vs Firecracker vs Kata vs nsjail vs V8 Isolates; fuel vs cgroups; pool vs fresh |
| `09-cross-questions.md` | 12 hard interviewer questions with crisp rebuttals |
| `10-cheat-sheet.md` | Compact talking points for interview delivery |

## Related Pack

`2026-05-06-wasm-sandbox-platform/` - full end-to-end WASM sandbox architecture (request intake, scheduling, execution, logging, streaming, cleanup). This pack focuses specifically on the security and isolation enforcement mechanisms.
