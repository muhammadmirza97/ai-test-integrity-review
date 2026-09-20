# Threat Model

## Assets

- integrity of PASS/WARN/BLOCK/ERROR decision
- repository source code
- tests and fixtures
- Git history
- developer workstation
- GitHub-hosted runner
- any CI credentials that happen to exist
- release artifacts of Merge Integrity itself

## Trust boundaries

1. Merge Integrity source/package
2. scanned repository
3. scanned PR changes
4. GitHub runner operating system
5. Jest/Vitest process
6. Stryker process
7. Git executable
8. package dependencies

Repository and PR content are untrusted.

## Primary threats

### False PASS
Most dangerous product failure.

Examples:

- parser silently skips a changed test;
- test runner crashes and is interpreted as success;
- base ref cannot be resolved but verification continues;
- mutation tool fails and report says all mutants killed;
- red/green verifier treats import error as legitimate RED.

Mitigation: fail closed.

### False BLOCK
Commercially dangerous because users disable noisy CI.

Mitigation:

- BLOCK only high-confidence deterministic cases;
- ambiguous semantics -> WARN;
- regression fixtures;
- clean historical-PR validation before public beta.

### Command injection
Malicious filename/config gets included in shell command.

Mitigation: process APIs with argument arrays; no string shell construction.

### Path traversal
Malicious path escapes temp/project root.

Mitigation: canonicalization and root containment checks.

### Policy tampering
PR edits config to disable the integrity gate.

Mitigation: load protected policy from base branch.

### Secret exfiltration
PR tests attempt to access secrets.

Mitigation: no required secrets; ordinary `pull_request`; document self-hosted-runner risk.

### Supply-chain compromise
Dependency or Action compromised.

Mitigation: minimal dependencies, lockfile, scanning, pinned Actions, protected release.

### Resource exhaustion
PR creates extremely expensive tests or mutation workload.

Mitigation: timeouts, max mutants, stage budgets, cancellation.

### Indirect prompt injection
Repository content tells an LLM/agent to override policy.

MVP mitigation: no runtime LLM.

Future: strict untrusted-content boundary, no model-controlled tools, structured output, no direct decision authority.

## Abuse scenarios to test

- filename `"; curl attacker"` style strings
- test name containing shell metacharacters
- nested `../../` paths
- symlink escaping repository root
- `.merge-integrity.yml` changed to disable rules
- missing base history
- intentionally hanging test
- child process that outlives parent
- massive generated test file
- malformed JS/TS
- README/test comment with prompt injection instructions
- package script attempting to print environment variables
- Stryker failure
- Jest/Vitest non-zero exit unrelated to assertion

---

## Implementation status (technical MVP)

This section records how each threat is handled in the implemented code and what remains. It is kept
consistent with [SECURITY.md](../SECURITY.md).

| Threat | Mitigation implemented | Evidence (tests) | Residual risk |
| --- | --- | --- | --- |
| False PASS | Fail-closed pipeline: stage status must be `completed`, `disabled` or `not-applicable`; parse failures, Git failures, runner crashes, timeouts, inconsistent runner reports, Stryker failures and cleanup failures are ERROR. | `policy.test.ts`, `check-deterministic.test.ts`, `classify-run.test.ts`, `red-green.test.ts`, `mutation-plan.test.ts`, `mutation.test.ts` | Tests not matching `*.test.*`/`*.spec.*`/`__tests__` are not analysed; skip mechanisms outside the supported syntax (aliases such as `const s = it.skip`, `if (false)`, early `return`) are not detected. |
| False BLOCK | BLOCK by default only for syntactic skip/focus, uniquely matched tests with reviewed weakening transformations, deterministic script bypasses and gate/policy weakening; assertion removal, red/green non-discrimination and everything uncertain are advisory WARN. | `rule-fixtures.test.ts`, `policy.test.ts`, synthetic validation, 58-PR calibration (0 BLOCKs under the default policy, POLICY_RECALIBRATION.md) | The blocking rules produced no hits in the calibration corpus, so their real-world precision rests on fixtures and synthetic cases. |
| Command injection | `spawn` with argument arrays, `shell: false`, ESLint bans `exec`/`execSync`/`shell: true`; refs after `--end-of-options`; `GIT_LITERAL_PATHSPECS=1`. | `process-run.test.ts`, metacharacter file/test-name cases in integration tests | Git and the project's test tools are trusted executables from PATH/node_modules. |
| Path traversal / symlink escape | Contained relative paths only; worktree writes from Git objects with symlinked-parent refusal; symlinked test files → ERROR; dependency links removed before recursive delete; runtime-created links are not followed during cleanup. | `git-and-reports.test.ts`, `check-deterministic.test.ts`, `red-green.test.ts` | — |
| Policy tampering | Base policy by default; MI106 for weakening; MI005 for removing the gate from a workflow; MI106 for `config-source: head` or stage-disabling inputs in a workflow. | `check-deterministic.test.ts`, `test-command-bypass.test.ts` | **With `pull_request`, the workflow file itself comes from the PR.** A PR can replace the workflow; mitigate with CODEOWNERS/branch protection or required workflows. |
| Secret exfiltration / privilege escalation | No secrets required; child processes lose `ACTIONS_*`, `INPUT_*`, well-known tokens and step file-command paths; workflow commands suspended while untrusted text is printed; `pull_request_target` refused. | `process-run.test.ts`, `red-green.test.ts`, `action-e2e.test.ts` | Tests run as the same OS user: a determined malicious test can still read runner files (e.g. `.git/config` if `persist-credentials` is left enabled) or tamper with later steps. Use hosted runners, `persist-credentials: false`, no secrets. |
| Supply chain | 3 bundled runtime dependencies (MIT/ISC); install scripts denied; frozen lockfile; SHA-pinned Actions; Dependabot; CodeQL; audit + licence workflow. | `scripts/check-licenses.mjs`, `pnpm audit` | CodeQL/Dependabot configuration has not yet run on GitHub. |
| Resource exhaustion | Red/green and mutation time budgets with process-tree kill; output caps; 2 MB parse limit; max-mutant budget planned exactly before Stryker runs. | `process-run.test.ts`, `red-green.test.ts`, `mutation-plan.test.ts`, `mutation.test.ts` | Deterministic stage has per-Git-call timeouts but no overall budget. On Windows, processes that detach from the tree after the runner exits cannot be reaped. |
| Indirect prompt injection | No runtime LLM or agent. | `rule-fixtures` security fixtures, `check-deterministic.test.ts` | None in MVP. Any future LLM feature requires design review (CLAUDE.md). |
| Mutation tool unreliability | Mutants enumerated with the project's own Stryker instrumenter and matched 1:1 with the report; unvalidated Stryker/Jest/Vitest versions are ERROR (Vitest 5 + vitest-runner 10.0.0 was observed to report every mutant as survived). | `mutation-plan.test.ts`, `mutation.test.ts` | Version allowlist must be maintained as Stryker and runners release. |

Additional threats identified during implementation:

- **Workflow replacement under `pull_request`** (above). Not solvable inside the Action; documented.
- **Forged step outputs.** A detached process started by a test could write to runner files after the Action
  exits. Only the job status should be trusted; outputs are informational.
- **Shared dependencies.** (Remediated.) Each worktree has its own `node_modules` directory linking to installed
  packages; top-level tool caches are created inside the disposable worktree, and any modification of installed
  packages during a run is detected by an inode/size/mtime/ctime fingerprint and reported as ERROR.
- **Cross-run state contamination.** (Remediated.) Every execution uses a fresh worktree and a fresh HOME/TMP/cache
  sandbox; covered by `red-green-adversarial.test.ts`.

## Independent review remediation (2026-09-17)

| Finding | Mitigation | Evidence | Residual risk |
| --- | --- | --- | --- |
| PR-controlled Action inputs (base-ref/head-ref, red-green, mutation, config-source, working-directory, config, framework) | On `pull_request`/`merge_group`: refs only from the event; weakening inputs → ERROR; identical base/head → ERROR | `action.test.ts`, `action-e2e.test.ts` (bundle) | A PR can still delete the gate step or replace the workflow; requires the repository protection in SECURITY.md (required check without bypass, CODEOWNERS, required workflows) |
| Workflow gate tampering detected by regex | YAML-structural comparison; MI005 for removal, MI106 (BLOCK) for inputs/`if`/`continue-on-error`/triggers/Action repository/CLI command changes | `workflow-integrity.test.ts` | Only detectable when the gate still runs in some workflow |
| MI106 severity | Default BLOCK | `workflow-integrity.test.ts`, `action-e2e.test.ts` | Policy loosening requires maintainer override of the PR |
| One RED test masking another | Per-test verification and MI006 per changed test | `red-green-adversarial.test.ts` | Companion tests that pass on base are BLOCKed (false-BLOCK risk, unmeasured) |
| Reused writable execution state | Fresh worktree + sandbox per execution; dependency fingerprint | `red-green-adversarial.test.ts` | Detached daemon processes; tests sharing state within one file run |
| Arbitrary secrets inherited by tests | Allowlisted environment; explicit base-policy passthrough | `env-and-executables.test.ts`, `action-e2e.test.ts` | Values in allowlisted variables (e.g. `NODE_OPTIONS`) and files readable by the runner user |
| Tautology misclassification | Literal assertions evaluated; contradictions are not tautologies | `tautology.test.ts` | Only modelled matchers are evaluated |
| Host Node used for project tooling | `node` resolved from PATH (absolute, excluding relative/repository entries) | `env-and-executables.test.ts`, integration suites | If PATH has no `node`, verification is ERROR |
| Unknown custom test layouts silently analysed as default | Static `testMatch`/`include`/`dir` honoured; unsupported discovery → MI107 WARN (advisory) | `discovery.test.ts` | Static patterns are unioned with defaults (analysis can be wider than the runner's) |
