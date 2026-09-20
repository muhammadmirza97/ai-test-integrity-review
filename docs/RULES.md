# Rules

Severities are defaults and can be changed per rule in `.merge-integrity.yml` (`block` or `warn`); in protected CI
only the base-branch policy applies, and lowering a severity in a pull request is itself MI106 (BLOCK).
Default severities follow two tiers, calibrated on 58 historical merged PRs ([POLICY_RECALIBRATION.md](../POLICY_RECALIBRATION.md)):

- **Blocking (high-confidence tampering):** MI001, MI002, MI004, MI005, MI106. These fail the check.
- **Advisory (test-quality evidence for review):** MI003, MI006, MI101–MI105, MI107. These are reported as warnings
  and do not fail the check by default, in CI or locally.

A base-branch owner may make any advisory rule blocking (`rules: { <ID>: block }`) or fail on every warning
(`policy.warningsBlockMerge: true`). A pull request cannot weaken this: protected runs read policy only from the
base branch, and lowering a severity in a PR is MI106.

| ID | Default | Detects | Confidence discipline |
| --- | --- | --- | --- |
| `MI001_TEST_SKIPPED` | block | A test or suite gains `.skip`, `xit`/`xtest`/`xdescribe`, `skipIf(true)`/`runIf(false)`, or a test with a body becomes `.todo`; new skipped tests | Purely syntactic; counted per test key so pre-existing skips are ignored |
| `MI002_TEST_FOCUSED` | block | A test or suite gains `.only`, `fit` or `fdescribe` | Purely syntactic |
| `MI003_ASSERTION_REMOVED` | warn | Assertions removed from a uniquely matched test (or hook) with no replacement; always-true assertions (`expect(true).toBe(true)`, `expect(1).toBe(1)`, `assert.equal(1, 1)`) do not count as replacements. Constant contradictions such as `expect(1).toBe(2)` are **not** treated as always true | Downgraded to MI101 when the test was renamed/duplicated or new helper calls might contain the assertions |
| `MI004_ASSERTION_WEAKENED` | block | Reviewed transformations on the same subject: exact/specific matcher → `toBeDefined`/`toBeTruthy`/`toBeFalsy`/`not.toBeUndefined`/`not.toBeNull`; `toHaveBeenCalledWith`/`Times` → `toHaveBeenCalled`; `toThrow(X)` → `toThrow()`; `toHaveProperty(k, v)` → `toHaveProperty(k)` | Reversed expectations and equivalent rewrites (`toBe(401)` → `toMatchObject({ status: 401 })`) are not flagged |
| `MI005_TEST_COMMAND_BYPASS` | block | `test` script removed or replaced by a no-op; `--passWithNoTests`; failures swallowed (`|| true`, `; echo`, `| tee`, `&`); name filter added to `test`; `passWithNoTests: true` in Jest/Vitest config; a workflow stops running Merge Integrity (gate step removed, commented out, or workflow deleted — determined by parsing the YAML) | Scripts are tokenised, never executed; unknown commands produce MI101 instead |
| `MI006_REGRESSION_TEST_NON_DISCRIMINATING` | warn | **Each** changed or added test case that passes on the PR head **and** on the base implementation (per test, not per file: a RED test cannot verify its neighbours) | Runs only when implementation files also changed; downgraded to MI103 when dependency manifests changed; tests whose names are generated at runtime are MI103 |
| `MI101_ASSERTION_CHANGE_AMBIGUOUS` | warn | Possible weakening that cannot be confirmed (conditional skips, `.fails`, helper extraction, renamed tests, strict→loose equality, removed `expect.assertions`, invisible test runner, only the pinned version of the gate Action changed) | — |
| `MI102_MUTATION_SURVIVED` | warn | A Stryker mutant on a changed production line survived (or was not covered). Mutation testing is opt-in | Mutants limited to added/modified lines and `maxMutants` |
| `MI103_RED_GREEN_INCONCLUSIVE` | warn | Red/green could not produce assertion-level evidence for a changed test (import/compile/setup/runtime errors on base, base test already failing, test not collected, runtime-generated test name, flaky RED) | Never counted as verified |
| `MI104_TEST_DELETED` | warn | A test or test file was deleted (tests moved unchanged to another file are ignored) | — |
| `MI105_COVERAGE_SCOPE_REDUCED` | warn | Test selection, exclusion or coverage-threshold settings changed; scope-narrowing CLI flags added; runner config deleted | — |
| `MI106_POLICY_WEAKENED` | **block** | The PR weakens `.merge-integrity.yml` (lower severities, disabled stages, new ignores, new environment passthrough, smaller budgets, moved working directory, invalid proposed policy) or changes how the gate runs in a workflow: gate inputs, step/job `if`, `continue-on-error`, `pull_request`/`merge_group` triggers or their filters, a different Action repository, a changed CLI command, or an unparsable gate workflow | Reported whether or not the weaker policy was applied |
| `MI107_TEST_DISCOVERY_UNSUPPORTED` | warn | The project's test discovery (`testRegex`, projects/workspaces, dynamic or spread configuration) cannot be read statically and the PR changes JavaScript/TypeScript files that were not recognised as tests | Only reported when unrecognised code files changed |

`MI106` and `MI107` are additions to the PRD rule list: the PRD requires that policy differences be surfaced, and
the independent review required unsupported test layouts to be reported rather than silently passed.

## When a finding is wrong, or keeps appearing

- **MI103 and MI107 on every pull request** usually mean the repository is in a LIMITED row of
  [ALPHA_SUPPORT_MATRIX.md](ALPHA_SUPPORT_MATRIX.md) (discovery that cannot be read statically, tests that need
  a build step or environment). Run `merge-integrity doctor` — it names the cause before a run.
- **A BLOCK you believe is wrong** is the most serious defect this product can have: please report it
  ([SUPPORT.md](../SUPPORT.md)), rather than lowering the severity quietly.
- Symptom-by-symptom help: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
