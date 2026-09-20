# AI Test Integrity Review

**Independent test-integrity review for AI-generated pull requests.** It answers one question with evidence:
did this pull request weaken its tests, and do its changed tests actually exercise the change?

> Your coding agent should not be the only system marking its own work.

- **Catches high-confidence test tampering** — skipped or focused tests, reviewed assertion weakening,
  test-command bypass, weakening of the gate itself — and fails the check for it.
- **Runs the changed tests against the old code** (red/green): a real regression test must fail before the fix
  and pass after it. Optional targeted mutation testing on changed production lines.
- **Surfaces uncertain cases as warnings** — removed assertions, non-discriminating tests, unverifiable tests,
  unsupported discovery — without blocking development.

No backend, no account, no telemetry, no LLM, no secrets. Your code never leaves the runner.

**Status: alpha (`v0.1.0-alpha.1`).** Jest and Vitest, JavaScript/TypeScript, GitHub only. Expect rough edges,
and read [what this does not do](#what-this-does-not-do) before you rely on it. **Run it unenforced first** —
this alpha exists to find out whether its findings are useful, not to police your merges.

> The CLI binary (`merge-integrity`), the policy file (`.merge-integrity.yml`) and the check's own output still
> carry the project's original `merge-integrity` name; only the product and repository were renamed for the
> alpha.

## Results: PASS, WARN, BLOCK, ERROR

| Result | Meaning | Job |
| --- | --- | --- |
| **PASS** | No blocking integrity finding. | success |
| **WARN** | Review recommended: advisory evidence such as a removed assertion or a test that could not be verified. Normally non-blocking. | success |
| **BLOCK** | High-confidence integrity issue: a test was skipped, focused, weakened in a reviewed transformation, bypassed, or the gate was weakened. | failure |
| **ERROR** | The analysis could not safely complete. **This is not a claim that the pull request is safe.** | failure |

Only MI001, MI002, MI004, MI005 and MI106 block by default. Everything else is advisory unless the base-branch
policy raises it. See [docs/RULES.md](docs/RULES.md).

## Start here (about 10 minutes)

### 1. Preflight — before you enforce anything

Add `.github/workflows/merge-integrity-preflight.yml` (copy
[examples/github-workflow-preflight.yml](examples/github-workflow-preflight.yml)) and run it from
*Actions → Merge Integrity preflight → Run workflow*:

```yaml
      - run: npm ci
      - uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.1
        with:
          mode: doctor
```

It answers **SUPPORTED**, **SUPPORTED WITH WARNINGS** or **UNSUPPORTED** in the Step Summary and explains every
finding, without running your tests and without ever failing the job. It detects Yarn Plug'n'Play, Vitest
browser mode, a Jest config only reachable through the test script, unreadable test discovery, missing
dependencies, shallow clones, unsupported Node, and more — see
[docs/ALPHA_SUPPORT_MATRIX.md](docs/ALPHA_SUPPORT_MATRIX.md).

Prefer to run it locally? Clone this repository, `pnpm install --frozen-lockfile && pnpm build`, then from your
own project: `node <path-to-clone>/packages/cli/dist/main.js doctor` (add `--format json` for a pasteable
report).

### 2. Install the workflow

Add `.github/workflows/merge-integrity.yml`:

```yaml
name: Merge Integrity
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  merge-integrity:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.1
```

Pin to an exact commit SHA for anything you enforce:
`muhammadmirza97/ai-test-integrity-review@9ec8249fd0d4dda327684766d5c1b3b828f09e3a`
(see [docs/INSTALL.md](docs/INSTALL.md)).

### 3. Open a pull request and read the result

The job prints the result, writes a Step Summary, and annotates the changed lines. Leave it **unenforced**
(not a required check) for at least a week of real pull requests before you consider making it required.

### 4. When something looks wrong

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) is organised by symptom. If a BLOCK is wrong, please report
it — see [SUPPORT.md](SUPPORT.md). A false BLOCK is the most serious defect this product can have.

### 5. Turning it off

Remove the check from your required status checks, or delete the workflow file. There is nothing else installed
and no data anywhere to delete ([PRIVACY.md](PRIVACY.md)).

## What this does not do

- It does **not** prove a pull request is correct, safe or ready to merge. A PASS means "no blocking integrity
  finding", nothing more.
- It does **not** detect whether code was written by an AI, and does not try to.
- It does **not** catch every way tests can be gamed. Its blocking rules are deliberately narrow; recall against
  real-world tampering is unmeasured.
- It does **not** review code quality, style, security or performance.
- It does **not** replace your test suite, your CI, or a human reviewer.
- It does **not** work everywhere: Jest/Vitest on JavaScript/TypeScript, GitHub, one project directory per run.
  Yarn Plug'n'Play, Vitest browser mode and several other setups are unsupported
  ([support matrix](docs/ALPHA_SUPPORT_MATRIX.md)).
- It does **not** upload your code, use an LLM, need a secret, or collect telemetry ([PRIVACY.md](PRIVACY.md)).
- ERROR is **not** a pass: when the analysis cannot complete, the check fails rather than guessing.

## How it decides

```text
PR diff
→ deterministic test-integrity rules (skip, only, removed/weakened assertions, command bypass, policy tampering)
→ red/green verification (changed tests must fail on the base implementation with a real assertion failure)
→ targeted Stryker mutation testing of changed production lines (opt-in)
→ PASS / WARN / BLOCK / ERROR
```

## Scope

- JavaScript / TypeScript (JS, TS, JSX, TSX), Jest and Vitest
- GitHub pull requests (`pull_request`, `merge_group`) via a Node 24 JavaScript Action
- Local CLI: `merge-integrity check` and `merge-integrity doctor`
- No backend, database, dashboard, billing, telemetry, LLM, hosted source ingestion or auto-fixing
- Repository code runs only on your machine or your GitHub runner; no secrets are required

## Evidence so far

- 58 merged pull requests from 15 public repositories were analysed
  ([CALIBRATION_RESULTS.md](CALIBRATION_RESULTS.md)), then re-scored and partly re-run after the policy
  recalibration ([POLICY_RECALIBRATION.md](POLICY_RECALIBRATION.md)).
- Under the current default policy: **0 BLOCKs on 58 accepted pull requests** (95% upper bound on the per-PR
  false-BLOCK rate ≈ 5%), and 11 of 58 runs ended in ERROR, almost all from unsupported repository setups —
  which is what the preflight now detects up front.
- Detection evidence comes from rule fixtures and 18/18 synthetic tampering scenarios. **Real-world recall is
  unmeasured**: the calibration corpus contained no known tampering.
- Verified end to end on real GitHub pull requests (clean PR → PASS, `it.skip` → BLOCK, weakening input →
  ERROR). Enforcement as a *required* status check that actually prevents a merge has **not** been proven yet.

## Documentation

- [Installation and configuration](docs/INSTALL.md) · [Support matrix](docs/ALPHA_SUPPORT_MATRIX.md) ·
  [Troubleshooting](docs/TROUBLESHOOTING.md) · [Support](SUPPORT.md)
- [Rules](docs/RULES.md) · [Red/green verification](docs/RED_GREEN.md)
- [Security policy](SECURITY.md) · [Threat model](docs/THREAT_MODEL.md) · [Privacy](PRIVACY.md) ·
  [Licence](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md) · [Architecture](docs/ARCHITECTURE.md) · [Test strategy](docs/TEST_STRATEGY.md) ·
  [Security guardrails](docs/SECURITY_GUARDRAILS.md)
- Evidence: [calibration results](CALIBRATION_RESULTS.md) · [policy recalibration](POLICY_RECALIBRATION.md)

## Development

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm fixtures:install
```

```bash
pnpm verify
```

See the detection rules work on throwaway repositories (18 tampering scenarios, no network):

```bash
node scripts/validation/synthetic-tampering.mjs
```

Layout: `packages/core` (analysis library), `packages/cli` (CLI), `packages/action` (GitHub Action;
`dist/index.cjs` is the committed bundle), `test-repos/` (Jest, Vitest 4 and Vitest 5 fixtures), `scripts/`
(fixtures, licence check, validation).

## Known limitations (summary)

- Test discovery uses standard naming plus static Jest `testMatch` / Vitest `include`/`dir`; anything else
  produces MI107 (advisory warning) and incomplete coverage of your test files.
- Red/green needs tests that run without a build step or generated files, and that do not write into installed
  dependencies.
- MI006 is evaluated per changed test, so companion/guard tests that correctly pass on the base are reported;
  it is advisory by default.
- Mutation testing is opt-in and requires Stryker 10; validated with Jest 27–30 and Vitest 2–4 (Vitest 5 → ERROR).
- With `pull_request`, GitHub runs the workflow file from the pull request. The Action refuses weakening inputs
  and reports gate edits, but deleting or replacing the workflow must be prevented by repository protection
  (see [SECURITY.md](SECURITY.md#operating-guidance)).
- About one in five calibration pull requests ended in ERROR because of unsupported setups. Run the preflight
  first.
