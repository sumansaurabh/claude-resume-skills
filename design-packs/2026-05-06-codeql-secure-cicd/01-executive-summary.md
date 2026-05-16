# 01 - Executive Summary

## The Direct Answer

We were trying to catch six classes of vulnerabilities systematically:

1. **Injection** (command injection, path traversal, code injection via user-supplied training scripts)
2. **Secrets and credential leakage** (API keys, SAS tokens, Managed Identity tokens committed to code or emitted in logs)
3. **Insecure dependencies** (pip packages and Go modules with published CVEs in the training harness and platform services)
4. **Supply chain** (base container images with high/critical CVEs)
5. **Unsafe cryptographic practices** (weak ciphers, improper certificate validation, insecure randomness in the Rust protocol layer)
6. **Kubernetes-specific escalation** (pod specs that bypassed security contexts, RBAC over-grants in operator manifests)

The recurring vulnerabilities that triggered this investment were: hardcoded storage SAS tokens in Python training scripts checked into git, and command injection in a job-spec rendering path where user-supplied hyperparameter values were interpolated into a shell command without sanitization.

---

## The 60-Second Verbal Answer

> "The trigger was two recurring vulnerability classes that kept showing up in security reviews. First, developers kept committing SAS tokens and service principal secrets into training scripts - easy to do when you're debugging locally and forget to clean up. Second, there was a path in our job spec renderer where user-supplied hyperparameter strings were interpolated into a shell command. That's command injection, and it came up twice before we standardized the fix.
>
> So we integrated three tools. CodeQL for static analysis - we configured it for Go and Python with the standard security queries plus custom queries for our platform-specific patterns (unsafe pod spec construction, improper tenant ID validation in API handlers). GitHub Advanced Security secret scanning to catch tokens and keys before they hit main. And Dependabot + GitHub's dependency review to block PRs that introduced known-CVE dependencies.
>
> For the Rust TunDRA codebase, CodeQL had limited support at the time, so we used cargo-audit for dependency CVEs and a custom CI step that counted unsafe blocks - any new unsafe block required a security sign-off.
>
> After rollout, we eliminated two classes of recurring vulnerabilities within 90 days and blocked 14 high-severity dependency CVEs before they merged. More importantly, the pipeline created a forcing function for the threat model work: every new component needed a CodeQL query to cover its specific risk, which meant developers had to think about their attack surface before writing the query."

---

## What Makes This a Good Answer

A weak answer: "We ran CodeQL on our Go code to catch common vulnerabilities."

A strong answer names:
- The **specific vulnerability classes** relevant to your platform
- The **trigger incidents** that motivated the investment
- The **customizations** made beyond default query packs
- The **limits** of SAST (what it doesn't catch)
- The **outcome metrics** (vulnerabilities eliminated, CVEs blocked)
- The **cultural outcome** (threat model forcing function)
