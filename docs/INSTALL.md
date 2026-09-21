# Installation and configuration

Status: alpha (`v0.1.0-alpha.2`). Not published to npm or the GitHub Marketplace; install from the tag or a
pinned commit of this repository.

> **A note on names.** The product and this repository are called **AI Test Integrity Review**. The CLI binary
> (`merge-integrity`), the policy file (`.merge-integrity.yml`) and the text the check prints still use the
> project's original `merge-integrity` name. Renaming those would have changed verified behaviour right before
> the alpha, so it was deliberately left for later.

## Preflight first

Before installing anything, check that your repository is supported. The preflight runs no tests and changes
nothing.

**Option A — as a GitHub Action (no local checkout).** Add `.github/workflows/merge-integrity-preflight.yml`:

```yaml
name: Merge Integrity preflight
on: workflow_dispatch
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
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
      - uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.2
        with:
          mode: doctor
```

Run it from *Actions → Merge Integrity preflight → Run workflow* and read the Step Summary. `mode: doctor`
never fails the job, and it is **refused** on `pull_request`/`merge_group` runs (it would replace the gate with
a no-op). A preflight step is not treated as the gate either, so adding or deleting a preflight workflow is
never reported as removing the gate — but turning a real gate step into `mode: doctor` is (MI005).

**Option B — locally**, after `pnpm install --frozen-lockfile && pnpm build`:

```bash
node packages/cli/dist/main.js doctor
```

```bash
node packages/cli/dist/main.js doctor --format json
```

The verdict is **SUPPORTED**, **SUPPORTED WITH WARNINGS** (exit 0) or **UNSUPPORTED** (exit 2). Each check says
what was found and what you can do. See [ALPHA_SUPPORT_MATRIX.md](ALPHA_SUPPORT_MATRIX.md) for the full
envelope and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for symptoms.

## Requirements

- A GitHub repository with a JavaScript/TypeScript project using **Jest** or **Vitest**.
- One project per repository in protected CI (the project directory is `workingDirectory` in the base-branch
  policy). The CLI can analyse other packages with `--working-directory`.
- Node.js `^22.18.0 || >=24.11.0` for the CLI; the Action runs on GitHub's Node 24 runtime. The project's own
  tests and Stryker run with the `node` found on PATH (for example the version selected by `actions/setup-node`).
- Full Git history in CI (`fetch-depth: 0`).
- Deterministic rules and red/green verification need nothing beyond the project's installed dependencies.
- **Mutation testing is optional (off by default).** To enable it, set `mutation.enabled: true` in the policy and
  install `@stryker-mutator/core@10` plus the matching runner. Validated versions: Jest 27–30 with
  `@stryker-mutator/jest-runner@10`, Vitest 2–4 with `@stryker-mutator/vitest-runner@10`. Other versions produce
  ERROR when mutation is enabled. `merge-integrity doctor` reports whether mutation testing can be enabled.

```bash
npm install --save-dev @stryker-mutator/core@10 @stryker-mutator/jest-runner@10
```

## GitHub Action

Add `.github/workflows/merge-integrity.yml` (see [examples/github-workflow.yml](../examples/github-workflow.yml)):

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
      - uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.2
```

**Pin by commit SHA for anything you enforce.** A tag can be moved; a SHA cannot:

```yaml
      # v0.1.0-alpha.2
      - uses: muhammadmirza97/ai-test-integrity-review@b64598d9c60c636ce5ca50d9815c5c60726de74b
```

That SHA is the commit the `v0.1.0-alpha.2` release points at; every release page shows the commit it was
built from.

### Try it without enforcing it

Keep the check out of your required status checks until you have seen it on real pull requests for a week. If
you want it to be visible but never red while you evaluate, run it in a job with `continue-on-error: true` —
but remember that this also hides real BLOCKs, so remove it before you rely on the result.

Then configure the repository protection described in [SECURITY.md](../SECURITY.md#operating-guidance):
required `merge-integrity` status check without bypass, CODEOWNERS review for `.github/workflows/` and
`.merge-integrity.yml`, and ideally an organisation ruleset with a required workflow. Add the check to the merge
queue if you use one.

### Inputs

On `pull_request` and `merge_group` the workflow file belongs to the pull request, so **inputs cannot weaken the
run**: base/head always come from the event, settings come from the base-branch policy, and the following make the
run fail with ERROR: `mode` other than `check`, `base-ref`, `head-ref`, `config-source` other than `base`,
`red-green: false`, `mutation: false`, a non-default `working-directory`, `config` or `framework`.
`mutation: true` (stricter) is accepted. Other events (for example `workflow_dispatch`) may use every input.

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `check` | `doctor` runs the compatibility preflight and never fails the job; rejected on `pull_request`/`merge_group` |
| `working-directory` | policy | Manual runs only |
| `config` | `.merge-integrity.yml` | Manual runs only |
| `config-source` | `base` | Manual runs only (`head` loads the PR's policy) |
| `framework` | policy | Manual runs only |
| `mutation` | policy | `true` enables mutation testing for the run; `false` is manual runs only |
| `red-green` | policy | `false` is manual runs only |
| `base-ref` / `head-ref` | from event | Manual runs only |

### Outputs

`status` (`pass`/`warn`/`block`/`error`), `blocker-count`, `warning-count`, `report-path` (JSON report).

### Result mapping

| Status | Job result |
| --- | --- |
| PASS | success |
| WARN | success (failure if `policy.warningsBlockMerge: true`) |
| BLOCK | failure (exit 1) |
| ERROR | failure (exit 2) — no merge decision was made |

Only high-confidence tampering rules (MI001, MI002, MI004, MI005, MI106) block by default. Every other finding,
including MI003, MI006, MI103 and MI107, is an advisory warning for the reviewer and does not fail the check unless
the base-branch policy makes that rule `block` or sets `policy.warningsBlockMerge: true`. ERROR always fails.

The Step Summary lists findings; file/line findings are also shown as annotations on the PR diff.

## CLI

Build from source (until published):

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

```bash
node packages/cli/dist/main.js doctor --base origin/main
```

```bash
node packages/cli/dist/main.js check --base origin/main --head HEAD
```

`check` options: `--base` (required), `--head` (default `HEAD`), `--working-directory`, `--framework`,
`--config`, `--config-source base|head` (default `base`), `--format text|json`, `--output <file>`,
`--no-mutation`, `--no-red-green`. Exit codes: 0 PASS/non-blocking WARN, 1 BLOCK, 2 ERROR.

## Policy file: `.merge-integrity.yml`

All keys are optional except `version`. Unknown keys, unknown rule IDs and invalid values are errors.

```yaml
version: 1
workingDirectory: "."
framework: auto            # auto | jest | vitest
policy:
  warningsBlockMerge: false
redGreen:
  enabled: true
  timeoutSeconds: 120      # total budget for red/green runs
mutation:
  enabled: false           # opt-in; requires Stryker 10 in the project
  timeoutSeconds: 180      # total budget for enumeration + Stryker
  maxMutants: 25           # hard cap; a deterministic subset is chosen when exceeded
testEnvironment:
  passthrough: []          # extra environment variable names the project's tests may see (all others withheld)
rules:                     # severities: block | warn
  MI006_REGRESSION_TEST_NON_DISCRIMINATING: block   # stricter than the default (warn)
  MI102_MUTATION_SURVIVED: warn
ignore:                    # every entry needs rule, a scoped path glob and a reason
  - rule: MI104_TEST_DELETED
    path: "tests/legacy/**"
    reason: "Legacy suite is being retired under tracked migration."
```

Ignored findings stay visible in every report. Patterns that match everything (`**`, `*`, `**/*`) are rejected.
The base-branch policy is always applied in protected CI. A pull request that weakens the policy (lower
severities, disabled stages, new ignores, new passthrough variables, smaller budgets, a moved working directory)
is BLOCKed by MI106; loosening the policy therefore requires a deliberate maintainer override of that PR.

The project's tests run with a minimal environment. If they legitimately need variables such as a test database
URL provided by the workflow, list the names under `testEnvironment.passthrough`. `ACTIONS_*`, `INPUT_*`,
`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` and step file-command variables are always withheld.

## What the project must provide

- Installed dependencies before the gate runs (it never installs anything).
- Tests that run without a prior build step or untracked/generated files (otherwise red/green reports ERROR).
- Tests that do not write into installed dependencies during a run (that is reported as ERROR).
- Test files named `*.test.*` / `*.spec.*`, placed in `__tests__/`, or matched by a static Jest `testMatch` or Vitest
  `test.include`/`test.dir`. Discovery that cannot be read statically (`testRegex`, projects/workspaces, dynamic
  configs) is reported as MI107 (advisory WARN).

See [RULES.md](RULES.md) for what each finding means and [RED_GREEN.md](RED_GREEN.md) for verification details.
