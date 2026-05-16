# CodeQL and GitHub Advanced Security in CI/CD

**Design pack:** `design-packs/2026-05-06-codeql-secure-cicd/`

**Interview question:**
> "You integrated CodeQL and GitHub Advanced Security into CI/CD. What classes of vulnerabilities were you trying to catch?"

**Resume rating:** 8/10 - strong supporting topic; connects secure protocol design mentorship to concrete engineering outcomes.

---

## File Map

| File | Contents |
|---|---|
| `00-question-and-context.md` | Scope, platform context, resume anchors |
| `01-executive-summary.md` | Direct answer + 60-second verbal delivery |
| `02-vulnerability-classes.md` | All 6 vulnerability classes with platform-specific triggers, CodeQL queries, and fix patterns |
| `03-tooling-and-configuration.md` | GitHub Actions YAML, CodeQL config, Dependabot setup, Trivy, cargo-audit |
| `04-threat-model-connection.md` | How threat modeling drove custom queries; SDL compliance; mentoring outcomes |
| `05-cross-questions.md` | 9 skeptical interviewer questions with rebuttals |
| `06-cheat-sheet.md` | One-page verbal guide, numbers, traps |

---

## The 6 Vulnerability Classes

1. **Injection** - command injection via hyperparameter values in job spec renderer
2. **Secrets in code** - SAS tokens, service principal credentials in training scripts
3. **Dependency CVEs** - pip and Go module vulnerabilities in training harness and platform services
4. **Container image CVEs** - base image OS packages with HIGH/CRITICAL findings
5. **Weak cryptography** - MD5 in checkpoint manifests, InsecureSkipVerify in internal clients, Rust unsafe blocks
6. **Kubernetes pod spec injection** - user input flowing into operator security context fields

---

## Key Outcome Numbers

| Metric | Value |
|---|---|
| Existing findings at rollout | 23 → cleared to 0 in 90 days |
| Real secrets blocked (6 months) | 11 |
| High-severity CVE merges blocked | 14 |
| Recurring vulnerability incidents after rollout | 0 |

---

## How to Use This Pack

1. **Read `01-executive-summary.md`** - internalize the 60-second answer and the 6 classes
2. **Read `02-vulnerability-classes.md`** - understand the platform-specific triggers for each class
3. **Drill `05-cross-questions.md`** - the 9 questions cover the most likely attack angles
4. **Day-of: `06-cheat-sheet.md`** - the one-page review
