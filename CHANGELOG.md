# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0-alpha.1] — unreleased (prepared)

First external alpha. **Nothing has been published**: no GitHub Release, no Marketplace listing, no npm package.

### Release notes

AI Test Integrity Review gives a reviewer independent evidence about one question: did this pull request weaken
its tests, and do its changed tests actually exercise the change?

- **Blocks only high-confidence tampering** (MI001 skipped, MI002 focused, MI004 reviewed assertion weakening,
  MI005 test-command bypass, MI106 gate/policy weakened). On 58 merged pull requests from 15 public
  repositories, these rules produced **zero** BLOCKs.
- **Red/green verification**: changed tests are run against the base implementation in an isolated worktree; a
  regression test must fail there with a real assertion failure and pass on the new code.
- **Targeted mutation testing** of changed production lines (opt-in, Stryker 10).
- **Everything uncertain is advisory** (WARN) and does not fail the check by default.
- **ERROR is never PASS**: if the analysis cannot complete, the check fails and says so.
- No backend, account, telemetry, LLM or secrets. Code never leaves the runner.

Know before you install: Jest/Vitest and JavaScript/TypeScript only; one project directory per run; Yarn
Plug'n'Play and Vitest browser mode are unsupported. Run the preflight first —
[docs/ALPHA_SUPPORT_MATRIX.md](docs/ALPHA_SUPPORT_MATRIX.md).

### Added

- **Compatibility preflight** (`merge-integrity doctor`, and the Action's `mode: doctor`) now returns
  **SUPPORTED / SUPPORTED WITH WARNINGS / UNSUPPORTED** with a reason and a remedy for every finding. New
  statically-evidenced checks: package manager and **Yarn Plug'n'Play**, **Vitest browser mode** (including
  inside `projects`), configuration reachable only through the `test` script, colour flags that break
  snapshots, environment variables set by the test script, build/`pretest` steps, custom test runners,
  framework version against the validated range, test-file discovery, workspace roots, and the existing Node,
  Git, history, config and Stryker checks.
- `merge-integrity doctor --format json`.
- Action input `mode` (`check` by default). `mode: doctor` never fails the job and is **refused** on
  `pull_request`/`merge_group`; turning a real gate step into a preflight is reported (MI005), while adding or
  deleting a preflight workflow is not treated as removing the gate.
- `docs/ALPHA_SUPPORT_MATRIX.md`, `docs/TROUBLESHOOTING.md`, `docs/ALPHA_VALIDATION_PLAN.md`, `SUPPORT.md`,
  `PRIVACY.md`, `LICENSE` (Apache-2.0), `THIRD_PARTY_NOTICES.md`, this changelog.
- GitHub issue forms for incorrect findings, compatibility/ERROR reports, useful findings and general alpha
  feedback, each with a warning not to paste secrets or private code.
- `release/PUBLIC_RELEASE_MANIFEST.md` and `scripts/release/export-public.mjs`: a reproducible,
  allowlist-based public export that fails on missing required files or detected secrets.
- `examples/github-workflow-preflight.yml`.
- A test that parses every shipped YAML file (issue forms, example workflows, example policy, `action.yml`),
  after an unquoted value broke one issue form.

### Fixed

- The example policy file no longer sets MI003/MI006 to `block` or enables mutation testing: copying it used
  to re-introduce exactly the noise the 2026-09-19 recalibration removed.
- A `mode: doctor` step is no longer treated as the gate, so adding or deleting a preflight workflow cannot be
  reported as removing the gate (MI005).

### Changed

- Licence: `UNLICENSED` → **Apache-2.0**.
- README rewritten around the first-time user journey (preflight → install → first pull request → results →
  troubleshooting → removal), with an explicit "What this does not do" section.
- Version `0.1.0` → `0.1.0-alpha.1` in the root and package manifests and in `merge-integrity --version`.

### Earlier work (before this alpha packaging)

- **Policy recalibration** (commit `9a7cf10`, documented in `POLICY_RECALIBRATION.md`): only high-confidence
  tampering blocks; MI003 and MI006 became advisory; the rule that failed protected runs on MI103/MI107 was
  withdrawn. Protected-CI failures on the calibration corpus fell from 31/58 to 11/58 and false BLOCKs from 7
  to 0.
- **D1 fixed**: changed tests are matched per test key with a context signature, so unchanged tests with
  duplicate or runtime-generated names are no longer treated as changed.
- **D2 fixed**: BigInt values no longer crash canonicalisation.
- 50-PR calibration (`CALIBRATION_RESULTS.md`) and end-to-end validation on real GitHub pull requests.

[0.1.0-alpha.1]: https://github.com/muhammadmirza97/ai-test-integrity-review/releases/tag/v0.1.0-alpha.1
