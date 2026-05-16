# WASM Sandbox Execution Platform

**Design pack:** `design-packs/2026-05-06-wasm-sandbox-platform/`

**Interview question:**
> "You say you architected a Golang-backed WASM sandbox plane for 1M+ daily code executions. Walk me through the full architecture: request intake, scheduling, sandbox creation, execution, isolation, logging, result streaming, and cleanup."

**Resume anchor:** BlackBox, Principal Engineer, Sep 2025 – Apr 2026. Golang-backed WASM sandbox plane isolating 1M+ daily zero-shot code executions, unblocking Enterprise SOC-2 compliance.

---

## File Map

| File | Contents |
|---|---|
| `00-question-and-context.md` | Question scope, platform context (sandbox as agent tool), assumptions |
| `01-executive-summary.md` | One-paragraph answer + 60-second verbal delivery |
| `02-architecture.md` | Mermaid component map, 11-step request flow, pre-warm pool, wazero selection rationale |
| `03-api-and-contracts.md` | REST API, SSE event schema, error model, idempotency, agent tool contract |
| `04-low-level-design.md` | Worker struct, ModuleCache, PoolManager, StreamManager, state machine, Redis schema |
| `05-scaling-and-capacity.md` | Throughput model, bottleneck analysis, cold start problem, autoscaling, cost model |
| `06-security-and-isolation.md` | SOC-2 controls, STRIDE analysis, WASI configuration, defense-in-depth layers |
| `07-reliability-observability-and-failures.md` | Failure taxonomy, worker crash handling, OTel spans, SLOs, debug runbook |
| `08-tradeoffs-and-alternatives.md` | WASM vs Docker vs gVisor, wazero vs Wasmtime, SSE vs WebSocket |
| `09-cross-questions.md` | 11 skeptical Q&As covering isolation, security, scaling, and leadership |
| `10-cheat-sheet.md` | One-page verbal guide with numbers, comparisons, and trap answers |

---

## Architecture in One Diagram

```
User (Copilot UI / LangGraph Agent)
         │ POST /v1/execute (SSE)
         ▼
┌─────────────────────────────────┐  CONTROL PLANE (Go)
│ API Gateway + Rate Limiter      │
│ Request Validator               │
│ Execution Scheduler             │
│ Stream Manager (SSE fanout)     │
│ Audit Logger (OTel)             │
└─────────────────────────────────┘
         │ Go channel dispatch
         ▼
┌─────────────────────────────────┐  EXECUTION PLANE (Go workers)
│ Pre-Warm Pool (200 workers)     │
│   Worker (wazero runtime)       │
│   ├── WASM Module Instance      │
│   │   (Pyodide / QuickJS)       │
│   ├── WASI: stdin/stdout only   │
│   ├── Memory: 128MB cap         │
│   └── Timeout: 30s              │
│   ↓ stdout/stderr chunks        │
│ Stream Manager → SSE → Client   │
└─────────────────────────────────┘
         │ OTel spans
         ▼
┌─────────────────────────────────┐  STORAGE
│ Redis (rate limits, exec state) │
│ Clickhouse (audit log, SOC-2)   │
│ Object Storage (WASM cache)     │
└─────────────────────────────────┘
```

---

## Key Numbers

| Metric | Value |
|---|---|
| Executions/day | 1M+ |
| Warm start p99 | <50ms |
| Cold start (Python) | ~800ms (mitigated by pool) |
| Pre-warm pool | 200 workers |
| WASM memory cap | 128MB |
| Execution timeout max | 30s |
| Audit log retention | 2 years (Clickhouse) |

---

## How to Use This Pack

1. **Read `01-executive-summary.md`** - the 60-second answer is your delivery target
2. **Study `02-architecture.md`** - know the Mermaid diagram and the 11-step flow cold
3. **Understand `06-security-and-isolation.md`** - the SOC-2 story is what makes this a Principal Engineer answer, not just a systems design answer
4. **Drill `09-cross-questions.md`** aloud - Q1-Q4 on WASM isolation are the most likely attack angles
5. **Day-of: `10-cheat-sheet.md`** - the one-page guide
