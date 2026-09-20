# 50-PR Calibration Results

Run 2026-09-19 against the unchanged product (Action `muhammadmirza97/ai-test-integrity-review@3dd3fa7486cc61a1eaab15ad53e3867c25118e93`,
default configuration, mutation off). Machine-readable data: calibration-results.json (raw data, kept in the private development repository).
Workflow run: a private validation repository (workflow run 35416042001)

## Executive verdict

**STOP / REPOSITION** (in the current form: a required, fail-closed merge check).

Under protected CI the check would have been **red on 31 of 58 (53%) pull requests that maintainers accepted**.
All 7 BLOCKs were false BLOCKs, and no true-positive BLOCK was found. 11 PRs (19%) ended in ERROR, and 3 of 15
repositories (20%) hit unsupported test discovery (MI107) on every JavaScript change. Runtime is not the problem:
the gate step's median was 0.6 s, and 10.5 s when red/green ran. The per-test red/green engine works mechanically:
it proved a real regression test RED→GREEN in 8 PRs across 6 repositories. But as a required gate, the noise is
far above what a normal team would tolerate. A merged PR is only a proxy for a legitimate change, and 58 PRs is
a small sample, but these failure modes are not marginal.

## Sample

- **58 merged PRs from 15 public repositories** (24 Jest, 34 Vitest), selected by `scripts/calibration/select-prs.mjs`.

| Repository | Framework | Package manager | PRs |
| --- | --- | --- | --- |
| gvergnaud/ts-pattern | Jest 30 | npm | #346 #341 #332 #261 |
| moment/luxon | Jest 29 | npm | #1790 #1787 #1775 #1707 |
| typestack/class-validator | Jest 29 | npm | #2672 #2618 #2626 #2647 |
| harrisiirak/cron-parser | Jest 30 | npm | #450 #445 #439 #417 |
| jest-community/jest-extended | Jest 30 | Yarn Berry | #965 #885 #878 #879 |
| react-hook-form/react-hook-form | Jest 30 | pnpm | #13762 #13759 #13758 #13756 |
| toss/es-toolkit | Vitest 4 | Yarn Berry (PnP) | #2099 #2100 #2088 #1815 |
| pmndrs/zustand | Vitest 4 | npm | #3570 #3560 #3555 #3443 |
| pmndrs/jotai | Vitest 5 | pnpm | #3367 #3337 #3356 #3313 |
| cheeriojs/cheerio | Vitest 4 | npm | #5540 #5213 #5156 #5418 |
| krisk/Fuse | Vitest 4 | npm | #836 #830 |
| reduxjs/reselect | Vitest 4 | pnpm | #798 #784 #760 #781 |
| axios/axios | Vitest 4 | npm | #11179 #11125 #11194 #11152 |
| node-cron/node-cron | Vitest 4 | npm | #615 #607 #606 #595 |
| unjs/ufo | Vitest 4 | pnpm | #335 #325 #313 #293 |

**How PRs were picked.**
- *Repositories:* actively maintained, single-package JS/TS libraries using Jest or Vitest with a committed lockfile.
  They were screened for framework, lockfile, workspaces and activity. Excluded up front: very old Jest (dayjs),
  Bun-only (hono), and frameworks other than Jest/Vitest.
- *PRs:* each repository's merged PRs into the default branch, walked newest-first. Each PR was classified by the
  files it changed, and the first N of each category were taken (usually 2 test, 1 production, 1 tooling), with no
  hand-picking.
- *Skipped:* docs-only PRs. Bot dependency PRs were **not** excluded; for cheerio and jest-extended nearly every
  recent PR is one.

**Categories** (from file paths):

| Category | PRs | Meaning |
| --- | --- | --- |
| test | 32 | test files changed, with or without production code |
| prod | 14 | production JS/TS changed, no test files |
| tooling | 12 | manifests, lockfiles, config or CI only |

**Run method.**
- *Environment:* one disposable GitHub-hosted `ubuntu-latest` job per PR. `permissions: {}` and no secrets.
- *Setup:* clone the public repository; fetch the PR head and the PR's recorded base SHA; Node from `.nvmrc` if
  present, else 24.
- *Install:* from the lockfile with lifecycle scripts disabled (`npm ci --ignore-scripts`,
  `pnpm install --frozen-lockfile --ignore-scripts`, `yarn install --immutable --mode=skip-build`).
- *Gate:* the pinned Action with `base-ref`/`head-ref` inputs (a manual-style run). Protected-check outcomes below
  apply `exitCodeForProtectedRun` to each report.
- *Safety:* no third-party code ran on the development machine. The one local reproduction ran analysis only
  (`--no-red-green`). Nothing was uploaded anywhere except GitHub's own runners, and no upstream repository was modified.

**Not representative of:** all developers, monorepos, applications, or repositories whose CI sets environment
variables (e.g. TZ) that this job did not. Merged ≠ defect-free.

## Overall results

| Status | Count | Rate |
| --- | --- | --- |
| PASS | 27 | 46.6% |
| WARN | 13 | 22.4% |
| BLOCK | 7 | 12.1% |
| ERROR | 11 | 19.0% |

As a **required check** on `pull_request`/`merge_group`: **27 success (46.6%) / 31 failure (53.4%)**. Every one of
the 13 WARNs contained MI103 or MI107 and would therefore fail. No PR ended as "WARN but green".

| Category | PASS | WARN | BLOCK | ERROR |
| --- | --- | --- | --- | --- |
| test (32) | 5 | 10 | 7 | 10 |
| prod (14) | 10 | 3 | 0 | 1 |
| tooling (12) | 12 | 0 | 0 | 0 |

The gate stays out of the way of tooling PRs and mostly of production-only PRs; 27 of the 31 failures are on the PRs
it exists for: those that change tests. Of 32 test-changing PRs, **5 (16%) would get a green required check**.

Rule frequency (number of PRs with at least one finding):

| Rule | PRs |
| --- | --- |
| MI103_RED_GREEN_INCONCLUSIVE | 14 |
| MI107_TEST_DISCOVERY_UNSUPPORTED | 8 |
| MI006_REGRESSION_TEST_NON_DISCRIMINATING | 5 |
| MI104_TEST_DELETED | 4 |
| MI003_ASSERTION_REMOVED | 2 |
| MI001, MI002, MI004, MI005, MI101, MI105, MI106 | 0 |
| MI102 | 0 (mutation off by default) |

## Blocking findings

| Repo | PR | Rule | Classification | Explanation |
| --- | --- | --- | --- | --- |
| harrisiirak/cron-parser | [#450](https://github.com/harrisiirak/cron-parser/pull/450) | MI006 | FALSE BLOCK | Both blocked tests are **unchanged**; the base file has two tests with the same name. Product defect D1. The PR's real regression test was verified. |
| harrisiirak/cron-parser | [#445](https://github.com/harrisiirak/cron-parser/pull/445) | MI006 | FALSE BLOCK | 2 unchanged duplicate-named tests (D1) + 2 new guard tests ("a single zero is accepted") that correctly pass on the base. 4 regression tests verified. |
| jest-community/jest-extended | [#878](https://github.com/jest-community/jest-extended/pull/878) | MI006 | FALSE BLOCK | Security fix; 3 new happy-path tests for the function pass on the base (companion tests). Regression test verified. |
| pmndrs/zustand | [#3555](https://github.com/pmndrs/zustand/pull/3555) | MI006 | FALSE BLOCK | 4 of 5 new tests verified; the 5th guards a side effect of the fix. |
| node-cron/node-cron | [#606](https://github.com/node-cron/node-cron/pull/606) | MI006 | FALSE BLOCK | 7 new tests verified; 1 consistency guard passes on the base. |
| pmndrs/jotai | [#3337](https://github.com/pmndrs/jotai/pull/3337) | MI003 | FALSE BLOCK | v3 drops React 17; the removed assertion was the React-17-only branch of an `if`. |
| reduxjs/reselect | [#784](https://github.com/reduxjs/reselect/pull/784) | MI003 | FALSE BLOCK | PR removes the experimental `unstable_autotrackMemoize` API; the removed assertion exercised it. |

True positive 0 · likely true positive 0 · **false BLOCK 7** · unresolved 0.

## False-block analysis

- **Rate:** 7 of 58 PRs (12.1%); 7 of 47 PRs that reached a decision (14.9%); 7 of 32 test-changing PRs (22%).
  6 of 15 repositories had at least one.
- **Cause 1: per-test MI006 on companion/guard tests (4 PRs, including cron-parser#445).** Working as specified
  ("every changed test must discriminate"), but the specification blocks a normal, good practice. In every one of
  these PRs the regression test itself was verified RED→GREEN. Developers understand the message but can only
  "fix" it by deleting good tests.
- **Cause 2: product defect D1 (2 PRs; the whole of cron-parser#450).** Unchanged tests whose identity is not
  unique (duplicate names in one file, or a runtime-generated name) are treated as changed whenever anything else
  in the file changes.
  - Duplicate names then get MI006 BLOCK; dynamic names get MI103.
  - Reproduced locally: a PR that only adds one new test was BLOCKed on two untouched `it("adds")` tests.
  - The developer is told an untouched test fails to prove their change, which is neither understandable nor actionable.
- **Cause 3: MI003 on deliberate removals (2 PRs).** Removing a feature or dropped-platform support removes its
  assertions. Clear message, but merging needs a maintainer-owned base-branch ignore entry.
- **False PASS:** none observed, but a merged-PR corpus cannot measure false PASSes. Synthetic tampering (18/18)
  remains the only evidence there.

## MI006 analysis

- **5 PRs, 11 blocked tests.** Every MI006 PR also had verified regression tests (1, 4, 1, 4 and 7).
- **Excluding D1:** 7 genuinely new tests in 4 PRs passed on the base. All 7 are guard, consistency or happy-path
  tests written alongside the fix, which reviewers accepted. None was a fake regression test.
- **Mechanics:** red/green applied to 28 PRs (median gate time 10.5 s). The engine distinguishes RED from GREEN
  per test correctly on real repositories; the policy of blocking *each* non-discriminating test is what fails.

## MI103 analysis

**14 PRs (24%; 44% of test-changing PRs).** 7 of the 13 WARN-status required-check failures are MI103 alone.

| Cause | PRs |
| --- | --- |
| New API: the head test does not compile/type-check on the base (ts-jest), so it cannot be proven by assertion | 4 (ts-pattern ×2, class-validator ×2; up to 52 tests each) |
| Table-driven tests with runtime-generated names | 3 (ufo ×2, node-cron) |
| Unchanged runtime-named test flagged as changed (defect D1) | 2 (cron-parser) |
| Crash fix: base fails with `TypeError`, not an assertion | 2 (jest-extended, cheerio) |
| Test already failing on the base (dependency-bump PRs) | 2 (cheerio, jotai) |
| Changed file not collected by the default runner configuration | 1 (axios) |

Adding a feature together with its tests (the most common PR shape in TypeScript libraries) produces MI103, and
MI103 now fails the protected check. "Cannot prove" is currently indistinguishable from "fails to prove", and the
biggest source is normal feature development.

## MI107 analysis

**8 PRs in 3 of 15 repositories (20% of repositories).** Every JS-changing PR in those repositories fails the
required check.

| Repository | Cause |
| --- | --- |
| pmndrs/jotai (3 PRs) | spread in Vitest `test` settings |
| axios/axios (3 PRs) | Vitest `test.projects` (node + browser) |
| cheeriojs/cheerio (2 PRs) | `const config = defineConfig({...}); export default config`. The config is static; only the export through an identifier is rejected, so this is a parser limitation, not a genuinely unanalysable config |

MI107 fires even on production-only PRs (jotai#3313, cheerio#5156, axios#11152), which change no tests at all.
In practice it is a per-repository verdict, not a per-PR one. A repository that hits it can never get a green
check without an owner ignore entry, which silently removes the protection MI107 exists for.

## Runtime

| Measure | Median | p90 | Max |
| --- | --- | --- | --- |
| Merge Integrity step (all 58 PRs; every install succeeded) | 0.6 s | 21.1 s | 120.9 s (ERROR: time budget) |
| Merge Integrity step when red/green ran (28 PRs) | 10.5 s | 31.3 s | 120.9 s |
| Red/green stage (report timing, when run) | 10.1 s | 30.5 s | — |
| Deterministic analysis stage | 0.05 s | 0.5 s | 1.4 s |
| Dependency install | 9.4 s | 20.7 s | 34.3 s |
| Whole CI job (clone + setup + install + gate) | 26 s | 49 s | 131 s |

Total job time for 58 PRs was 29 runner-minutes. Runtime and operating cost are acceptable for PR CI on these
library-sized projects; larger suites are unmeasured.

## Installation/repository compatibility

- **Dependency installation:** 58/58 succeeded (npm 30, pnpm 17, Yarn Berry 11), with lifecycle scripts disabled.
- **ERRORs:** 11.

| ERROR class | PRs | Detail |
| --- | --- | --- |
| Unsupported repository/setup | 8 | Yarn Plug'n'Play has no `node_modules` (es-toolkit ×3); Jest config only passed via `--config` in the test script (react-hook-form ×3, not detected by MI107 or doctor); snapshots need the test script's `--color=true` (jest-extended); Vitest browser-mode project (axios) |
| Product defect | 1 | D2: `INTERNAL_ERROR: Do not know how to serialize a BigInt` in `canonical()` (`packages/core/src/ast/parse.ts`), reproduced locally with analysis only |
| Environment limitation | 1 | luxon's tests need `TZ=America/New_York`/`LANG`, which its own CI sets (owner-fixable via job env + policy passthrough) |
| Other (runtime budget) | 1 | node-cron#607: original scheduler test on the base exceeded the red/green time budget |
| Dependency/install failure | 0 | — |
| Repository test failure | 0 | — |

- **Test commands:** the repositories' own `test` script flags and config paths are not honoured (3 repositories
  affected). Every ERROR was fail-closed, and no ERROR became a PASS.
- **Reach:** 4 of 15 repositories (27%) could not be analysed correctly for their test-changing PRs because of setup
  alone (es-toolkit, react-hook-form, jest-extended, axios).

## Signal-to-noise assessment

> If I were a developer using AI coding agents, would I leave this required check enabled?

**No.** On this sample it would have turned red on more than half of the PRs maintainers merged, and on 84% (27
of 32) of the PRs that touched tests: the exact PRs it is meant to judge. None of the 7 BLOCKs was a real problem. Of the
24 non-BLOCK failures:
- 11 were setup/environment ERRORs;
- 13 were "could not verify" warnings that the protected policy turns into failures.

A team would learn within days that red usually means "the tool could not cope", and would then either make the
check non-required or add broad ignore entries. Both destroy the integrity guarantee.

What *does* hold up is advisory evidence. In 8 PRs (6 repositories) the tool showed, per test and in ~10 seconds, that a new
regression test failed before the fix and passed after it. For a reviewer looking at an agent-written PR, that
evidence has value. Under the product's own non-negotiable rule (a false PASS is the worst defect, so fail
closed), today's coverage of real repository setups makes fail-closed a false-failure machine.

## Commercial implication

- **Useful enough for alpha users?** Not as a required merge gate. There is a plausible case for an advisory
  "test-evidence report" on PRs (red/green proof, skipped/focused/weakened-test detection), but this calibration
  did not test that positioning with users.
- **Strongest selling point:** per-test red/green proof that a changed test fails on the old code and passes on
  the new code. It worked on real Jest and Vitest repositories in seconds, with no secrets, no backend and a
  read-only token.
- **Biggest adoption risk:** false failures. That covers per-test MI006 on companion tests, MI003 on deliberate
  removals, MI103 on new-API/table/crash-fix tests, MI107 on common Vitest config shapes, and ERROR on common
  repository setups (Yarn PnP, config via test-script flags, required env vars).
- **What should remain free:** the CLI and advisory PR report for public repositories. The deterministic tampering
  rules (skip/only/command bypass/weakened assertion) are cheap to run (median 0.05 s), but produced no hits in
  this sample, so their value is unmeasured.
- **Evidence for a paid private-repository version?** None. This calibration measured technical behaviour only. No
  user was asked anything, and technical success, which was partial here anyway, is not evidence of willingness to pay.

## Highest-impact problem and smallest justified changes (not implemented)

**The highest-impact problem is the fail-closed required-check contract applied to a verifier that often cannot
reach a verdict on real repositories.** It accounts for 24 of the 31 failed checks (13 MI103/MI107 WARNs +
11 ERRORs).

**Changes justified by the data** (listed, not made; measurement comes first):
1. Fix D1 (unchanged duplicate/dynamic-identity tests treated as changed): a correctness defect, 2 false BLOCKs.
2. Fix D2 (BigInt crash in `canonical()`): a correctness defect, 1 ERROR.

**Repositioning questions for the owner** (these are product decisions, not tuning):
1. Should the required check be limited to deterministic tampering rules, with red/green (MI006/MI103) and
   discovery (MI107) reported as advisory evidence?
2. Should MI006 require that *at least one* changed test discriminates, rather than *each*? All 5 MI006 PRs had
   verified regression tests.

## Recommended next action

**STOP / REPOSITION**
