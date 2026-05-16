# Question and Context

**Original question:** "How would you prevent malicious AI-generated code from escaping the sandbox or abusing CPU, memory, filesystem, or network access?"

## Scope and Assumptions

- Execution of untrusted LLM-generated code (zero-shot, no human review before execution)
- Golang host process; Wasmtime or wazero WASM runtime
- 1M+ daily executions (~12/sec average, bursty to ~50/sec)
- Multi-tenant enterprise environment with strict tenant isolation requirements
- SOC-2 Type II compliance required
- Attacker model: malicious prompt that causes LLM to emit attack code; jailbroken LLM emitting exfiltration attempts; adversarial user crafting code to escape the sandbox
- Defense goal: malicious code must not escape the runtime, exhaust platform resources, read tenant-adjacent data, or exfiltrate over the network

## Resume Anchors Used

| Anchor | Source | What It Grounds |
|--------|--------|-----------------|
| "Architected Golang-backed WASM sandbox plane isolating 1M+ daily zero-shot code executions, unblocking Enterprise SOC-2 compliance" | BlackBox resume bullet | WASM runtime choice, isolation design, SOC-2 control mapping, scale |
| "Led design of secure multi-tenant ML infrastructure across Kubernetes and Azure, including isolation strategies for LLM workloads" | Microsoft resume bullet | Kubernetes pod security, network policies, cgroup enforcement, multi-tenant separation |
| "Mentored 8 engineers on secure protocol design; standardized threat modeling to eliminate recurring vulnerabilities" | Microsoft resume bullet | Threat model structure, defense-in-depth methodology, STRIDE decomposition |
| "Co-developed TunDRA, a secure QUIC-based communication protocol in Rust powering 1M+ compute instances" | Microsoft resume bullet | Low-level security design, network trust boundary thinking, capability-based access analogies |

**Confidence:** High - two strong anchors (WASM sandbox at BlackBox, multi-tenant isolation at Microsoft) and two supporting anchors (threat modeling, TunDRA).

## What the Interviewer Is Probing

- **Depth on isolation layers** - not just "we used WASM" but specifically what WASM provides and what it does not
- **Exact resource enforcement mechanism per dimension** - fuel/instruction metering for CPU, linear memory max for memory, WASI FSConfig allowlist + ephemeral-only for filesystem, WASI import blocking + OS network namespace for network
- **Multi-layer defense-in-depth** - understanding that each layer assumes the one above it may be bypassed
- **Multi-tenant threat model** - distinction between same-tenant cross-execution leakage (fresh instance per run) and cross-tenant leakage (separate pools, separate ephemeral dirs)
- **Compliance operationalization** - connecting isolation controls to auditable SOC-2 evidence

## Archetype

`system-design` - used for architecture, API design, LLD, and multi-component platform questions. This question has strong security focus, so `06-security-and-isolation.md` is the deepest file. The archetype is not `security-review` because the question also asks for enforcement mechanism design, resource limit modeling, and LLD of the enforcement engine.
