# Policy Recalibration

Date: 2026-09-19. Product commit `9a7cf10` (D1 fix, D2 fix, repositioned default policy); 23 of 58 PRs re-run. Data:
calibration/policy-recalibration.json (raw data, kept in the private development repository), produced by
`scripts/calibration/recompute-policy.mjs` from calibration-results.json (raw data, kept in the private development repository) plus reruns.

## Method

- **Re-scored, not re-run (35 PRs):** the recorded 58-PR calibration findings were re-scored with the new default
  severities (read from the built rule catalogue). A PR is BLOCK only if a finding's rule is blocking, and ERROR stays
  ERROR. The required check fails only on BLOCK or ERROR (default `warningsBlockMerge: false`).
- **Re-run on commit `9a7cf10` (23 PRs):** same disposable GitHub-hosted runners and method as the calibration, in
  two runs:
  - Run 1 (a private validation repository (workflow run 35445024017)), 12 PRs:
    - the PRs whose result the fixes could change: cron-parser #445 and #450 (D1), axios #11179 (D2);
    - jotai #3337 and reselect #784, whose red/green had been skipped because a BLOCK already decided them;
    - a sanity sample of 7 PRs where red/green ran: luxon #1790, Fuse #836, zustand #3555, node-cron #606, ufo #313,
      jest-extended #878, class-validator #2626.
  - Run 2 (a private validation repository (workflow run 35445389772)), 11 more PRs:
    every other PR whose changed test files contain a test with non-unique identity (runtime-generated or table name,
    dynamic suite, or duplicated name), the only case the D1 fix can attribute differently. They were found by
    parsing the base and head test files with the product's analyser, without running anything
    (`scripts/calibration/d1-exposure.mjs`, output `calibration/d1-exposure.json`). All 11 kept their previous
    status, rules and ERROR causes.
- **Not re-cloned or re-installed (35 PRs):** they have no D1 exposure and were unaffected by D2 (only axios #11179
  crashed), so only their severities can change. Production-only and tooling PRs never had test changes.

## Default policy after repositioning

| Tier | Rules | Default |
| --- | --- | --- |
| High-confidence tampering | MI001 test skipped, MI002 test focused, MI004 assertion weakened (reviewed transformations on uniquely matched tests only), MI005 test-command bypass, MI106 gate/policy weakened | **BLOCK** (fails the check) |
| Advisory test-quality evidence | MI003 assertion removed, MI006 non-discriminating regression test, MI101 ambiguous change, MI102 mutation survived, MI103 red/green inconclusive, MI104 test deleted, MI105 scope reduced, MI107 discovery unsupported | **WARN** (does not fail the check) |

ERROR still fails the check (exit 2) and is never shown as PASS. Base-branch owners can raise any rule to `block`
or set `policy.warningsBlockMerge: true`. The previous rule that failed protected runs on MI103/MI107 is withdrawn.

## Results

| Measure | Previous policy | New policy |
| --- | --- | --- |
| PASS | 27 | 28 |
| WARN | 13 | 19 |
| BLOCK | 7 | **0** |
| ERROR | 11 | 11 |
| **Protected CI failures** | **31 of 58 (53%)** | **11 of 58 (19%)** |
| **False BLOCKs** | **7** (all 7 BLOCKs) | **0** |

### Rules responsible for the remaining failures

All 11 remaining failures are ERROR; none is a BLOCK.

| Cause | PRs |
| --- | --- |
| Unsupported repository/setup | 9: Yarn Plug'n'Play (es-toolkit ×3); Jest config passed only via `--config` in the test script (react-hook-form ×3); snapshots that need the test script's `--color=true` (jest-extended #885); Vitest browser-mode test files (axios #11194, and axios #11179 now that D2 no longer crashes it) |
| Environment limitation | 1: luxon #1787 needs `TZ`/`LANG`, which its own CI sets |
| Runtime budget | 1: node-cron #607, original test on the base exceeded the red/green budget |
| Product defect | 0 (D2 fixed) |

### Do the high-confidence tampering rules falsely block a legitimate calibration PR?

**No.** MI001, MI002, MI004, MI005 and MI106 fired on none of the 58 accepted PRs (0 findings), so they produced no
false BLOCK.

- **Upper bound on false BLOCKs:** with 0 events in 58, the 95% upper bound on the per-PR false-BLOCK rate is about
  5% (rule of three: 3/58).
- **Recall is not measured by this corpus:** it contains no known tampering, so it cannot show how well these rules
  catch it. Detection evidence comes from the rule fixtures and the 18/18 synthetic tampering scenarios, which still pass.

The stop condition ("remaining hard-block rules still falsely block normal historical PRs at a meaningful rate")
is not triggered.

### The 7 previous false BLOCKs under the new policy

| PR | Previous | Now | Why |
| --- | --- | --- | --- |
| cron-parser #450 | BLOCK MI006 ×2 + MI103 | **PASS** (re-run) | D1: the unchanged duplicate-named and runtime-named tests are no longer judged; the regression test is verified |
| cron-parser #445 | BLOCK MI006 ×4 + MI103 | WARN MI006 ×2 (re-run) | D1 removes the 2 unchanged duplicates and the runtime-named test; the 2 new guard tests remain advisory |
| jest-extended #878 | BLOCK MI006 | WARN MI006 + MI103 (re-run) | companion tests, advisory |
| zustand #3555 | BLOCK MI006 | WARN MI006 (re-run) | guard test, advisory |
| node-cron #606 | BLOCK MI006 + MI103 | WARN MI006 (re-run) | D1 removes MI103 on 2 unchanged runtime-named tests; the guard test is advisory |
| jotai #3337 | BLOCK MI003 | WARN MI003, MI103, MI104, MI107 (re-run) | red/green now runs: 1 verified, 29 inconclusive |
| reselect #784 | BLOCK MI003 | WARN MI003, MI103, MI104 (re-run) | red/green now runs: 1 inconclusive |

### D1/D2 effect in the sanity sample

- class-validator #2626: inconclusive tests went from 4 to 2. The 2 dropped are unchanged tests sharing the name
  "should return error object with proper data"; the 2 remaining are the PR's genuinely new tests.
- ufo #313: still MI103. Its runtime-named tests really changed through their case data, so they are still
  attributed correctly.
- luxon #1790, Fuse #836: unchanged (PASS, regression test verified).
- axios #11179: D2 fixed (no INTERNAL_ERROR); the PR now reaches red/green and errors on an unsupported Vitest
  browser-mode test.

### Advisory findings under the new policy (PRs with at least one)

| Rule | PRs |
| --- | --- |
| MI103 | 13 (was 14) |
| MI107 | 9 (was 8; axios #11179 now gets past the crash) |
| MI006 | 4 (was 5) |
| MI104 | 4 |
| MI003 | 2 |

These no longer fail the check. They remain noisy by design and are presented as evidence for review.

## What this does not fix

- **ERROR on unsupported setups is now the only source of red checks (19% of calibration PRs).** Examples: Yarn
  PnP, test-script-only config or flags, Vitest browser mode, required environment variables. It is fail-closed by
  design and was not in scope for this change.
- **Real-world recall of the blocking rules is unmeasured:** the calibration had no tampering PRs.
- **Runtime:** re-run gate times were similar to before, except for PRs that now run red/green instead of stopping
  at a BLOCK (jotai #3337: 61 s) and axios #11179, which now reaches red/green (98 s).
