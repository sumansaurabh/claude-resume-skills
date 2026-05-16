# 03 - Tooling and Configuration

## GitHub Advanced Security Feature Map

| Feature | What it does | How we configured it |
|---|---|---|
| **Code Scanning (CodeQL)** | SAST - finds vulnerabilities in code via data-flow analysis | Runs on every PR and push to main; SARIF results uploaded to GitHub Security tab |
| **Secret Scanning** | Scans commits for credential patterns | Push protection enabled for high-confidence patterns; custom patterns for Azure tokens |
| **Dependency Review** | Checks PRs for new high-severity dependency CVEs | Blocks merge on CVSS > 7.0; license check enforced |
| **Dependabot** | Auto-creates PRs for outdated dependencies with CVEs | Configured per ecosystem (pip, gomod); grouped minor updates to reduce PR noise |
| **Security Overview** | Aggregate view of alerts across repos | Used weekly in security standup to track open high/critical alerts |

---

## CodeQL Pipeline Configuration

### Languages and Query Suites

```yaml
# .github/workflows/codeql.yml
name: CodeQL Security Scan

on:
  push:
    branches: [main, release/*]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 2 * * 1'  # Full scan weekly (catches new queries from CodeQL releases)

jobs:
  analyze:
    name: Analyze (${{ matrix.language }})
    runs-on: ubuntu-latest
    strategy:
      matrix:
        language: [go, python]  # Rust used cargo-audit separately

    steps:
      - uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
          queries: +security-extended  # standard + extended security query pack
          config-file: .github/codeql/codeql-config.yml

      - name: Build (Go only)
        if: matrix.language == 'go'
        run: make build

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:${{ matrix.language }}"
          upload: true
          output: sarif-results/${{ matrix.language }}.sarif
```

### Custom Queries Configuration

```yaml
# .github/codeql/codeql-config.yml
name: "Platform Security Config"

queries:
  - uses: security-extended      # OWASP top 10 + extended SAST rules
  - uses: security-and-quality   # adds dead code, maintainability

paths-ignore:
  - '**/testdata/**'
  - '**/*_test.go'               # test files excluded from injection checks
  - '**/vendor/**'

paths:
  - 'services/'                  # control plane services
  - 'operator/'                  # Kubernetes operator
  - 'training/'                  # Python training harness

additional-queries:
  - ./codeql/queries/pod-spec-injection.ql       # custom: user input → pod spec
  - ./codeql/queries/tenant-id-validation.ql     # custom: missing tenant ID check in handlers
  - ./codeql/queries/uri-allowlist-bypass.ql     # custom: dataset URI not validated before use
```

### Query Severity Policy

| Severity | Action | SLA |
|---|---|---|
| **Critical** | Merge blocked; security team paged | Fix before merge, no exceptions |
| **High** | Merge blocked | Fix before merge or get explicit risk acceptance |
| **Medium** | PR comment + Security tab alert | Fix within 30 days |
| **Low** | Security tab alert only | Fix within 90 days or suppress with justification |

---

## Rust Security Pipeline (TunDRA)

CodeQL had limited Rust support at the time of the TunDRA development. The Rust-specific security pipeline was:

```yaml
# .github/workflows/rust-security.yml
jobs:
  cargo-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install cargo-audit
        run: cargo install cargo-audit --locked
      - name: Audit dependencies
        run: cargo audit --deny warnings

  unsafe-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Count unsafe blocks
        run: |
          UNSAFE_COUNT=$(grep -rn 'unsafe {' src/ | wc -l)
          echo "Unsafe block count: $UNSAFE_COUNT"
          # Fail if count increased from baseline
          BASELINE=7  # established in sprint 3; each increase requires sign-off
          if [ "$UNSAFE_COUNT" -gt "$BASELINE" ]; then
            echo "ERROR: unsafe block count $UNSAFE_COUNT exceeds baseline $BASELINE"
            exit 1
          fi

  clippy-security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Clippy with security lints
        run: cargo clippy -- -D clippy::undocumented_unsafe_blocks \
                             -D clippy::mem_forget \
                             -D clippy::large_futures \
                             -W clippy::integer_arithmetic
```

The `unsafe` block baseline approach deserves explanation: we did not aim for zero unsafe blocks (that's unrealistic in a network protocol implementation - QUIC's zero-copy buffer access requires some unsafe code). Instead we established a known-good count and required a documented security sign-off for every new unsafe block, including: what invariant makes this safe, what was checked to verify it, and who approved it.

---

## Secret Scanning Configuration

```yaml
# .github/secret_scanning.yml
paths-ignore:
  - 'testdata/**'
  - '**/*_fake*.go'

# Custom patterns registered via GitHub API (org-level)
# Not in repo config; configured in org security settings
```

**Push protection bypass process:**
When a developer needs to push a value that triggers a false positive (e.g., a test fixture that looks like a SAS token), they can request a bypass. The bypass is:
1. Logged in the GitHub audit log
2. Requires a written justification
3. Reviewed in the weekly security standup

Over 6 months, we had 3 legitimate bypasses (all test fixtures) and blocked 11 real secrets.

---

## Container Image Scanning

```yaml
# .github/workflows/image-scan.yml
jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Build image
        run: docker build -t finetuning:${{ github.sha }} .

      - name: Scan with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'finetuning:${{ github.sha }}'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'HIGH,CRITICAL'
          ignore-unfixed: true
          exit-code: '1'

      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'
          category: 'container-scan'
```

Trivy results feed into the same GitHub Security tab as CodeQL - one unified view of open vulnerabilities across code, dependencies, and container images.

---

## Dependabot Configuration

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "gomod"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      minor-and-patch:
        patterns: ["*"]
        update-types: ["minor", "patch"]
    reviewers:
      - "security-team"
    labels:
      - "dependencies"
      - "security"

  - package-ecosystem: "pip"
    directory: "/training"
    schedule:
      interval: "weekly"
    ignore:
      # torch major versions require manual testing; auto-update only patches
      - dependency-name: "torch"
        update-types: ["version-update:semver-major", "version-update:semver-minor"]
    reviewers:
      - "ml-infra-team"

  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
    reviewers:
      - "platform-team"
```

PyTorch was excluded from minor/major auto-updates because a minor PyTorch version bump can break the training harness in non-obvious ways (CUDA compatibility, API changes in `torch.distributed`). Security patches still auto-create PRs but require manual validation.

---

## Metrics Tracked

| Metric | Baseline | After 90 Days |
|---|---|---|
| Mean time to fix critical CodeQL findings | N/A (no pipeline) | 2.3 days |
| High-severity dependency CVEs blocked at merge | 0 (discovered post-merge) | 14 blocked (6 months) |
| Secrets blocked before reaching main | 0 | 11 (push protection) |
| Open critical/high CodeQL alerts (steady state) | 23 (discovered on rollout) | 0 (cleared within 90 days) |
| New unsafe Rust blocks requiring sign-off | N/A | 2 (both approved with justification) |
