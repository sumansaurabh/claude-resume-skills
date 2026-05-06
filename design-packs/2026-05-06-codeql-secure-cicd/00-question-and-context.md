# 00 — Question and Context

## Original Question

> "You integrated CodeQL and GitHub Advanced Security into CI/CD. What classes of vulnerabilities were you trying to catch?"

**Resume rating:** 8/10 — important supporting topic, not the centerpiece claim but a strong differentiator.

---

## Scope

This is a **secure engineering depth question**. The interviewer is not testing whether you know what CodeQL is — they're testing whether you:

1. Can reason about the specific vulnerability classes relevant to your platform
2. Used these tools intentionally (not just checked a compliance box)
3. Understand the limits of static analysis (what SAST catches vs. doesn't)
4. Connected the tooling to threat model outcomes and real vulnerability elimination

---

## Resume Anchors Used

| Claim | Source |
|---|---|
| Integrated CodeQL and GitHub Advanced Security into CI/CD pipelines | Microsoft experience bullet 4 |
| Standardized threat modeling to ensure Microsoft compliance | Microsoft experience bullet 4 |
| Eliminated recurring vulnerabilities | Microsoft experience bullet 4 |
| Mentored 8 engineers on secure protocol design | Microsoft experience bullet 4 |
| Secure multi-tenant ML infrastructure — isolation strategies | Microsoft experience bullet 2 |
| Co-developed TunDRA: QUIC-based protocol in Rust | Microsoft experience bullet 6 |
| Technologies: Go, Python, Rust, Kubernetes, Azure | Resume skills section |

---

## Platform Context (Critical for Answering Well)

The CI/CD pipeline protected four distinct code surfaces, each with different vulnerability profiles:

| Code Surface | Language | Risk Profile |
|---|---|---|
| **API services (control plane)** | Go (Gin/Go-kit) | Injection, path traversal, improper authN, information disclosure |
| **Training harness** | Python (PyTorch, DeepSpeed) | Dependency CVEs, insecure deserialization, hardcoded secrets, code injection |
| **Protocol implementation (TunDRA)** | Rust | Unsafe block misuse, integer overflow in protocol parsing, state machine bypasses |
| **Kubernetes operator / CRD controller** | Go | RBAC escalation, pod spec injection, supply chain (base images) |

---

## Classification

**Threat model / secure engineering** question. Depth expected on:
- SAST (static analysis) vulnerability classes
- Secret scanning
- Dependency scanning
- How these integrate with threat modeling
- What was actually fixed (recurring vulnerabilities eliminated)
