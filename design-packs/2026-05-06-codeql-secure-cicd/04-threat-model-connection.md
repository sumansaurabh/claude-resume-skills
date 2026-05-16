# 04 - Connection to Threat Modeling

## Why Threat Modeling and SAST Are Complementary, Not Redundant

Resume anchor: *"Standardized threat modeling to ensure Microsoft compliance and eliminate recurring vulnerabilities."*

The CI/CD pipeline (CodeQL, secret scanning, Dependabot) catches **known vulnerability classes** through automated pattern matching. Threat modeling identifies **novel attack paths** that no static analysis query exists for yet. The two are synergistic:

- Threat model identifies a new trust boundary or data flow → we write a CodeQL query to catch that pattern automatically in all future code
- CodeQL finds a vulnerability → we ask "how did our threat model miss this?" → we update the threat model template to include this class

---

## How Threat Modeling Drove Custom CodeQL Queries

### Example 1: Dataset URI Validation

**Threat model finding:** A tenant could supply a dataset URI pointing to another tenant's storage container. The threat model identified this as "Spoofing" at the Pod → Storage trust boundary.

**Initial mitigation:** Code review requirement that all dataset URIs be validated against the caller's tenant ID.

**Problem with code review:** Developers kept missing the check when adding new job types. It was caught in review 3 times in 6 months.

**CodeQL query created:**

```ql
// Detects handlers that use dataset_uri without calling validateDatasetURI()
import go

from Function f, Parameter p
where
  p.getName().matches("dataset_uri") and
  f.getBody() instanceof BlockStmt and
  not exists(CallExpr c |
    c.getCallee().getName() = "validateDatasetURI" and
    c.getAnArgument() = p.getAUse().asExpr()
  )
select f, "Handler uses dataset_uri parameter without calling validateDatasetURI()"
```

**Result:** Pattern became a compile-time enforcement rather than a review finding.

### Example 2: Tenant ID Propagation

**Threat model finding:** Control plane API handlers must always scope database queries to the authenticated tenant's ID. A missing `WHERE tenant_id = ?` clause would expose another tenant's jobs.

**CodeQL query created:**

```ql
// Detects DB query calls that don't include tenant_id filter
import go

from CallExpr dbCall
where
  dbCall.getCallee().getName().matches("Query*") and
  not exists(StringLit s |
    s.getValue().matches("%tenant_id%") and
    s = dbCall.getAnArgument()
  )
select dbCall, "Database query may be missing tenant_id filter"
```

> **Assumption:** This is a simplified version. The real query would use DataFlow to track the authentication context through the handler call stack, not a string match.

### Example 3: Pod Spec Privileged Escalation

**Threat model finding:** Kubernetes operator constructs pod specs from job request data. User-supplied values must not reach security-sensitive fields.

**Mitigation:** Centralize pod spec construction; all security fields hardcoded. (See `06-security-and-isolation.md` in the LLM training pack.)

**CodeQL query created:** Taint analysis from HTTP request parameters to `PodSpec.SecurityContext` fields.

---

## Threat Model Template (Post-Standardization)

After standardizing threat modeling across the team, every new platform component required a threat model with these sections:

```markdown
## Component: [Name]

### Assets
- What data does this component handle?
- What does this component control (access, execution, state)?

### Trust Boundaries
- Where does untrusted data enter this component?
- What other components does this component trust, and why?

### STRIDE Analysis
| Threat | Relevant? | Mitigation | CodeQL Query? |
|--------|-----------|------------|---------------|
| Spoofing | Y/N | ... | query name or "needs query" |
| Tampering | Y/N | ... | ... |
| Repudiation | Y/N | ... | ... |
| Info Disclosure | Y/N | ... | ... |
| DoS | Y/N | ... | ... |
| Elevation | Y/N | ... | ... |

### New CodeQL Queries Needed
- List any new taint flows identified that don't have existing coverage
```

The "CodeQL Query?" column was the forcing function. If the mitigation for a threat was "developer should check X," we required a CodeQL query to automate that check. This converted the threat model from a document into executable enforcement.

---

## Microsoft Compliance Requirements Addressed

The CodeQL + GitHub Advanced Security integration was part of satisfying Microsoft's **Security Development Lifecycle (SDL)** requirements, which mandate:

| SDL Requirement | How GHAS/CodeQL addressed it |
|---|---|
| **Threat analysis** | Threat models per component; mapped to CodeQL queries |
| **Static analysis tools** | CodeQL + golangci-lint on every PR |
| **Code review for security** | SARIF results surfaced in PR review UI |
| **Banned functions** | Custom CodeQL queries for platform-specific banned patterns |
| **Approved crypto** | `go/weak-crypto-key`, `go/insecure-tls`, cargo-audit |
| **Incident response** | GitHub Security Advisories for dependency CVEs; SLA tracked |

SDL compliance was an external audit requirement for the IPP (Internal Private Preview) program - enterprise customers' security teams reviewed the compliance documentation. The CI/CD pipeline produced automated evidence (SARIF reports, Dependabot PR history, secret scanning logs) that reduced the audit preparation burden from weeks to days.

---

## Mentoring 8 Engineers: What Actually Changed

Resume anchor: *"Mentored 8 engineers on secure protocol design."*

The tooling is easy to set up. The hard part is the culture: making engineers think about the security implications of their code as they write it, not as an afterthought when a security review catches something.

**What changed after the mentoring program:**

1. **Engineers wrote the threat model before writing the code** (not after). The template made this lightweight enough to be habitual.

2. **Engineers wrote CodeQL queries for their own new components.** The "needs query" column in the threat model template created a clear assignment. After 3 months, 5 of the 8 engineers had written at least one custom CodeQL query.

3. **Engineers started flagging security questions in design reviews proactively.** Before the program, security came up in 30-40% of design reviews (usually late in the discussion). After 6 months, it came up in 90%+ of reviews, typically in the first 10 minutes.

4. **The recurring vulnerability classes actually stopped recurring.** The two classes that triggered the investment (hardcoded secrets, command injection in hyperparameter rendering) had zero new instances in the 12 months after rollout.

The measure of success for the mentoring program was not "engineers passed the security training module" - it was the absence of the vulnerability classes that previously recurred.
