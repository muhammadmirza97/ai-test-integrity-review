# Red/green verification — how RED and GREEN are decided

Red/green verification answers one question for **each changed or added test case**:
**does this test fail against the old implementation and pass against the new one?**

It runs only when the pull request changes both tests and implementation files in the project.
(A PR that only adds tests for existing behaviour is not a regression-fix claim, so it is not judged.)

## Which tests are verified

The AST comparison of every changed test file yields the changed test cases in the head revision: added tests,
renamed tests, tests whose body changed, and every test in a suite whose hook (`beforeEach` etc.) changed.
Tests are identified by their suite path and name. Unchanged tests in the same file are run but are not required
to discriminate. Tests whose names are generated at runtime (`test.each`, template literals, dynamic names)
cannot be matched to runner results and are reported as inconclusive (MI103), never as verified.

## Isolation

Every execution — head, original base, base with the PR's tests overlaid, RED confirmation, and mutation testing —
starts from known-clean state:

1. A **fresh** detached `git worktree` of the commit under a unique OS temp directory (Git hooks disabled), removed
   immediately after that execution. No run can see files another run created.
2. A **fresh sandbox** per execution: `HOME`, `USERPROFILE`, `TMPDIR`/`TEMP`/`TMP`, `APPDATA`, `LOCALAPPDATA` and XDG
   cache/config directories point into it; Jest's cache directory and all reports live there too.
3. An **allowlisted environment** (see SECURITY.md): arbitrary parent variables and secrets are withheld.
4. **Dependencies:** each worktree gets its own real `node_modules` directory whose entries link to the installed
   packages, so tools that create top-level entries (`.vite-temp`, `.cache`, ...) write into the disposable worktree.
   The installed packages themselves are fingerprinted (inode, size, mtime, ctime of every entry — ctime cannot
   be set by unprivileged processes) before the first run and verified after every run; any modification is ERROR.
5. The project's tests run with the `node` found on PATH (resolved to an absolute path, ignoring relative and
   repository directories), not with the Merge Integrity host's Node.
6. Changed test files, test-support files and snapshots are written into base worktrees from the head commit's Git
   objects (never copied from the working tree); traversal and symlinked parents are refused.
7. Cleanup runs in `finally`: dependency links are removed first (deletion aborts if that fails), then the worktree,
   the temp directory, and `git worktree prune`. CLI/Action processes also clean up on SIGINT/SIGTERM.

## Sequence

| Step | Run (fresh worktree each time) | Handling |
| --- | --- | --- |
| 1 | changed test files on **head** | every file must pass; a changed test not reported as passed (skipped, not found) → MI103; any failure → **ERROR** |
| 2 | original test files on **base** (if they existed) | must pass; otherwise that file's changed tests → MI103; timeout/crash → **ERROR** |
| 3 | head test files overlaid on **base** | each changed test classified individually (below) |
| 4 | repeat step 3 for tests that were RED | RED must reproduce, otherwise MI103 (flaky) |

Step 3, per changed test:

| Test result on the base | Outcome |
| --- | --- |
| assertion failure (confirmed twice) | **verified** |
| passed | **MI006** (advisory WARN by default; MI103 if `package.json`/lockfile changed) |
| runtime error, skipped, not found, ambiguous duplicate name, file-level import/compile/setup error, not collected | MI103 WARN |
| process timeout or crash | **ERROR** |

A file is reported as verified only if every changed test in it is verified.

## What counts as an assertion failure

Evidence gathered by running Jest 30.5 and Vitest 4.1/5.0 against probe tests:

| Situation | Jest `--json` | Vitest `--reporter=json` |
| --- | --- | --- |
| `expect(...)` mismatch | `failureDetails[].matcherResult` present | message starts `AssertionError:` |
| snapshot mismatch | `matcherResult` present | message starts ``Error: Snapshot `…` mismatched`` |
| `node:assert` failure | no `matcherResult` → **not** counted (MI103) | `AssertionError [ERR_ASSERTION]:` → counted |
| `TypeError`, thrown `Error`, per-test timeout | no `matcherResult` | other message prefix |
| import/compile failure | failed suite, zero test results | failed suite with message, zero tests |
| `process.exit(0)` inside a test | **exit 0, no report** → crash → ERROR | test failure → runtime error |
| unhandled async error | test failure | **exit 1 with `success: true`** → inconsistent → not GREEN |

Per-test results are matched on `ancestorTitles` + `title`. A run is GREEN for a file only when the process exited 0,
a well-formed report exists, the file was collected, at least one test executed and every executed test passed.
A report that disagrees with the exit code is never trusted as GREEN.

## Known limitations

- Per-test MI006 also reports companion tests that legitimately pass on the base (for example a "17 is a minor"
  test added next to the "18 is an adult" regression test for an off-by-one fix). The 58-PR calibration found this
  pattern in 4 accepted PRs, so MI006 is advisory (WARN) by default; owners can set
  `MI006_REGRESSION_TEST_NON_DISCRIMINATING: block` in the base policy.
- Changed tests are identified by suite path and name. Unchanged tests whose names are duplicated or generated at
  runtime are not treated as changed because another test in the file changed; a runtime-named or table test counts
  as changed only when its own code or its surrounding case data (loop, table, suite declarations) changes.
- Tests are run per file and attributed per test; tests in the same file still share process state during a single
  execution.
- A test deliberately written to fail on the base (for example, asserting on file contents) is counted as RED.
  Red/green catches non-discriminating tests, not a determined adversary.
- Under Jest, `node:assert` failures are treated as inconclusive.
- Projects whose tests require a build step, generated files or untracked files fail on head and produce ERROR.
- Tests that legitimately write inside installed packages during a run produce ERROR.
- A detached background process started by a test (escaping the process group) could outlive its run.
- On Windows, background processes started by tests can outlive the run (process-tree cleanup after exit is
  POSIX-only).
