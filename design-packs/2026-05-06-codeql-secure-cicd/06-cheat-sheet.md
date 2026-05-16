# 06 - Cheat Sheet

## The 30-Second Answer

> "We were targeting six classes: injection (command/path) in the job spec pipeline, secrets committed to code (SAS tokens, service principal creds), dependency CVEs in Python and Go, container image vulnerabilities, weak cryptography in the Rust protocol layer, and Kubernetes pod spec injection via the operator. The trigger was two recurring findings - hardcoded storage tokens and command injection in hyperparameter rendering - that kept appearing in code reviews until we automated the checks."

---

## The 6 Vulnerability Classes (Memorize These)

| # | Class | Tool | Platform-specific trigger |
|---|---|---|---|
| 1 | **Command / code injection** | CodeQL Go+Python | Hyperparameter values interpolated into shell commands |
| 2 | **Secrets in code** | GH Secret Scanning | SAS tokens hardcoded in training scripts during debugging |
| 3 | **Dependency CVEs** | Dependabot + dep review | `requests` SSRF, `Pillow` RCE, `cryptography` OpenSSL CVEs |
| 4 | **Container image CVEs** | Trivy | Base image OS packages with HIGH/CRITICAL findings |
| 5 | **Weak cryptography** | CodeQL + cargo-audit | `md5.New()` in checkpoint manifest, `InsecureSkipVerify` in internal clients |
| 6 | **K8s pod spec injection** | Custom CodeQL | User input flowing into operator pod spec security fields |

---

## What CodeQL Doesn't Catch (Be Honest)

- Runtime injection (dynamically evaluated strings from DB records)
- Misconfigured RBAC / IAM policies (not code)
- Timing side-channel attacks (requires specialized analysis)
- Zero-day CVEs (not yet in advisory databases)
- Terraform/IaC misconfigurations (separate toolchain: Checkov/tfsec)

---

## Outcome Numbers to Cite

| Metric | Number |
|---|---|
| Existing findings at rollout | 23 (cleared to 0 in 90 days) |
| Real secrets blocked (6 months) | 11 |
| High-severity CVE merges blocked | 14 |
| Mean time to fix critical findings | 2.3 days |
| Recurring vulnerability incidents post-rollout | 0 |

---

## The Threat Model Connection (Key Insight)

> "The tooling and the threat model were connected: every threat model entry with 'developer should check X' as its mitigation needed to become a CodeQL query. That converted abstract documentation into executable enforcement and created a forcing function for developers to think about attack surfaces before writing code."

---

## Common Traps

| Trap | Best answer |
|---|---|
| "Did you actually write those queries?" | Yes - pod spec injection and tenant ID propagation queries. One engineer I mentored wrote the dataset URI query for their component. |
| "Semgrep is easier" | Used golangci-lint for simple patterns; CodeQL for multi-hop taint flows where data-flow analysis matters |
| "How do you avoid false positive fatigue?" | Track suppression-to-finding ratio; disable or refine queries with >3 suppressions per real finding |
| "Is secret scanning enough?" | No - also pre-commit hooks, Key Vault CLI for local dev, Managed Identity for production (nothing to commit) |
| "How did you justify cost?" | 11 secrets blocked × 4-8h rotation effort = ROI in first quarter; plus compliance certification risk for regulated-industry contracts |
