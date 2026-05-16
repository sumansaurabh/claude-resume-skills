# 05 - Cross-Questions and Rebuttals

## Q1: CodeQL is a static analysis tool - it only catches patterns in code. How did you handle runtime vulnerabilities that SAST can't see?

**Trap being set:** Testing whether you know the limits of SAST and have compensating controls.

**Best answer:** Correct - CodeQL won't catch an SSRF where the destination is determined at runtime from a database record, or a privilege escalation from misconfigured Azure RBAC (that's IAM policy, not code). Our compensating controls for runtime were: network egress controls (NetworkPolicy + NSG deny-all internet) that limited what a compromised pod could reach; Azure Policy for RBAC configuration drift; penetration testing for each major release; and runtime anomaly detection (unusual egress traffic to non-allowlisted endpoints). SAST is the first layer - it catches the easy, systematic stuff. Runtime controls contain the blast radius of what SAST misses.

---

## Q2: You said you standardized threat modeling. Threat modeling is usually something experienced security engineers do - how did you get an ML infrastructure team to do it consistently?

**Trap being set:** Testing whether your "standardization" was a one-time thing or durable culture.

**Best answer:** The key was reducing the activation energy. The full STRIDE analysis for a complex component takes days if you start from scratch. We created a template with pre-filled common patterns (injection, auth bypass, secret leakage) and a checklist format - an engineer could complete a meaningful threat model for a new API handler in 2-3 hours, not 2-3 days. The second mechanism was the CodeQL query requirement: the threat model template had a "CodeQL Query?" column that turned abstract mitigations into concrete engineering tasks. Engineers who are skeptical of "security documentation" are often happy to write a QL query, because that's real code. The third was accountability: threat models were required for every component that touched a trust boundary in the 30+ architecture reviews I led. If the threat model wasn't there, the review didn't proceed.

---

## Q3: You said you "eliminated recurring vulnerabilities." How do you know a vulnerability class is eliminated, not just unreported?

**Trap being set:** Testing whether you conflate "no alerts" with "no vulnerabilities."

**Best answer:** Fair challenge. My evidence is three-layered. First, CodeQL runs on every PR, so new instances of the specific patterns (command injection taint paths, secret literals in code) would show up as merge blockers - and none have in 12 months. Second, we ran a full repo scan when we rolled out CodeQL and found 23 existing findings. We tracked them to zero over 90 days. New findings would show up on the same dashboard. Third, for secrets specifically, GitHub's push protection creates an audit log of every bypass - we had 3 legitimate bypasses and 11 blocked real secrets. That's not zero secrets ever attempted, but it is zero secrets reaching the main branch. I'd be honest that a sufficiently novel pattern could evade existing queries - that's why we also did quarterly penetration testing and periodic CodeQL query updates from the upstream packs.

---

## Q4: Why didn't you use Semgrep instead of CodeQL? It's faster and easier to write custom rules.

**Trap being set:** Testing whether your tool choice was principled.

**Best answer:** Semgrep was considered. The decision came down to two factors. First, Microsoft's SDL compliance required a tool with a documented, auditable query library - CodeQL's query packs are maintained by GitHub Security Lab and have a formal disclosure process, which satisfied the compliance auditors. Semgrep's community rules don't have the same provenance. Second, CodeQL's data-flow analysis (taint tracking) is deeper than Semgrep's pattern matching for our primary concern - tracking user-supplied input across multiple function calls and Go struct fields. For simpler pattern checks (banned function names, crypto patterns), Semgrep is faster to write rules for, and we did use golangci-lint (which is faster than CodeQL for these cases) for the simpler Go rules. CodeQL and Semgrep aren't mutually exclusive; we used CodeQL for the complex taint analysis and golangci-lint for the fast, simple patterns.

---

## Q5: You mentioned a custom CodeQL query for pod spec injection. CodeQL queries are complex - did you actually write that, or did a security engineer write it?

**Trap being set:** Testing authenticity - did you personally do this or just oversee it?

**Best answer:** I wrote the initial version of the pod spec injection query and the tenant ID propagation query. The dataset URI validation query was written by one of the engineers I mentored as part of the mentoring program - that was deliberate, to give them ownership of the query for their component. I'm comfortable reading and writing QL for Go and Python taint flows; the syntax is unfamiliar to most engineers but the underlying concept is the same as writing a data-flow analysis in any other framework. I'd be honest that writing a production-quality CodeQL query for a complex multi-hop taint flow takes a few hours and requires testing against a sample of true positives and false positives - it's not trivial, but it's also not magic.

---

## Q6: Secret scanning catches secrets already committed to git. But what about secrets that developers only use locally and never commit?

**Trap being set:** Testing whether you understand the full secret lifecycle.

**Best answer:** You're right that push protection only stops secrets entering git. Secrets that exist only on developer laptops are a separate threat: credential theft, laptop loss, or developer departure. We addressed this with: (1) a mandatory `.gitignore` template for all training script repositories that excluded `*.env`, `*_key.txt`, `*secret*`, etc., enforced by a pre-commit hook; (2) required use of the Azure Key Vault CLI for local development instead of hardcoding - the `az keyvault secret show` command is a one-liner, so there's no strong motivation to hardcode when the ergonomics are reasonable; (3) Managed Identity for all production pod access, which eliminates the class entirely for production - you can't accidentally commit a Managed Identity because there's nothing to commit.

---

## Q7: How do you handle false positives from CodeQL? If developers learn to ignore alerts, the whole system becomes theater.

**Trap being set:** Testing whether you've thought about the human factors of security tooling.

**Best answer:** False positives were the number one adoption risk and we managed it actively. We started with the standard security-extended query pack, which had a false positive rate of about 20% in our Go codebase (mostly `go/path-injection` flagging internal path operations that were actually safe). We suppressed specific alert types for specific code patterns using CodeQL's `// lgtm` annotations (now `// codeql[rule-id]` suppression) with required comments explaining why the suppression is safe. We tracked the suppression-to-real-finding ratio: if a query had more than 3 suppressions per real finding, we either refined the query or disabled it. The goal was a low-noise feed where every alert deserved attention. At steady state, we had 0-3 new CodeQL alerts per week across all repos - high enough to catch real issues, low enough that engineers still read them.

---

## Q8: GitHub Advanced Security costs money. How did you justify the cost to management?

**Trap being set:** Testing whether you can connect security work to business outcomes.

**Best answer:** The cost justification was straightforward in the context of a $100M revenue platform serving enterprise customers with compliance requirements. A single security incident that exposed customer training data would: trigger breach notification requirements under GDPR/HIPAA, potentially invalidate the IPP compliance certification (which was the gating requirement for regulated-industry contracts), and create reputational damage that would set back enterprise sales by 12-18 months. The GitHub Advanced Security license cost was a rounding error compared to those risks. More practically: we had 11 real secrets blocked in the first 6 months and 14 high-severity CVE merges blocked. Each secret that reaches git requires rotation of all affected credentials across all environments - that's 4-8 hours of engineering time per incident. The tooling paid for itself in engineering time saved within the first quarter.

---

## Q9: Cargo-audit catches known CVEs in Rust dependencies. But the Rust ecosystem is small - are there even enough CVEs to matter?

**Trap being set:** Testing whether you understand the risk specifically for Rust.

**Best answer:** The Rust advisory database (RustSec) has over 600 advisories as of 2024, and the crates our protocol used (tokio, ring, rustls, hyper) are high-profile enough to attract serious security research. More relevantly for TunDRA: the biggest Rust security risks weren't dependency CVEs but our own code - specifically unsafe block correctness. A network protocol implementation that handles untrusted input (peer certificates, connection parameters) and uses unsafe blocks for performance is a meaningful attack surface. cargo-audit handled the dependency layer; the unsafe block count CI check and Clippy lints handled our own code. The combination was appropriate for the actual risk profile.
