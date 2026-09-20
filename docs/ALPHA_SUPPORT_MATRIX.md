# Alpha support matrix

What this alpha can analyse today, and what it cannot.

**NOT CURRENTLY SUPPORTED means "not supported by this alpha", not "your repository is wrong".** Most entries
below are ordinary, correct project setups; they are simply outside what has been built and verified so far.

Run the preflight before you enforce anything: add the Action with `mode: doctor`
(see [INSTALL.md](INSTALL.md#preflight-first)), or build this repository and run
`node packages/cli/dist/main.js doctor` against your project. It answers **SUPPORTED**,
**SUPPORTED WITH WARNINGS** or **UNSUPPORTED** and explains each finding.

Labels used below:

| Label | Meaning |
| --- | --- |
| **SUPPORTED** | Exercised by the test suite and/or the 58-PR calibration; expected to work. |
| **LIMITED** | Works, but with reduced value: some findings become advisory warnings (usually MI103/MI107) on every pull request. |
| **NOT CURRENTLY SUPPORTED** | Known to produce ERROR or no useful result. The preflight detects the cases marked *(detected)*. |

Evidence: [CALIBRATION_RESULTS.md](../CALIBRATION_RESULTS.md) (58 merged PRs, 15 repositories),
[POLICY_RECALIBRATION.md](../POLICY_RECALIBRATION.md), end-to-end runs on real GitHub pull requests, and the
repository's own test suite.

## Language and test framework

| Configuration | Status | Notes |
| --- | --- | --- |
| JavaScript / TypeScript (`.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`, `.jsx`, `.tsx`) | **SUPPORTED** | |
| Jest 29.x – 30.x | **SUPPORTED** | Validated in fixtures and 6 calibration repositories. |
| Vitest 4.x – 5.x | **SUPPORTED** | Validated in fixtures and 9 calibration repositories. |
| Jest 27–28, Vitest 1–3 | **LIMITED** | No evidence either way; the preflight warns. Mutation testing is validated for Jest 27–30 and Vitest 2–4. |
| Vitest browser mode (`test.browser.enabled: true`, including inside `projects`) | **NOT CURRENTLY SUPPORTED** *(detected)* | Browser-mode test files cannot be verified; runs ERROR. Calibration: axios ×2. |
| Mocha, AVA, node:test, Playwright/Cypress as the unit test runner | **NOT CURRENTLY SUPPORTED** *(detected)* | The preflight reports `framework: unsupported`. |
| Python, Go, Java, Ruby, .NET, anything non-JS/TS | **NOT CURRENTLY SUPPORTED** *(detected)* | Out of scope for this alpha. |

## Package manager and installation

| Configuration | Status | Notes |
| --- | --- | --- |
| npm (`package-lock.json`) | **SUPPORTED** | 30 calibration PRs. |
| pnpm (`pnpm-lock.yaml`) | **SUPPORTED** | 17 calibration PRs. |
| Yarn 1 (classic) | **SUPPORTED** | Uses `node_modules`. |
| Yarn Berry with `nodeLinker: node-modules` | **SUPPORTED** | 11 calibration PRs (jest-extended). |
| Yarn Berry with Plug'n'Play (the Yarn ≥ 2 default) | **NOT CURRENTLY SUPPORTED** *(detected)* | There is no `node_modules` tree, so the test runner cannot be resolved; every run ERRORs. Calibration: es-toolkit ×3. |
| Dependencies not installed before the gate runs | **NOT CURRENTLY SUPPORTED** *(detected)* | The gate never installs anything. Put `npm ci` / `pnpm install` / `yarn install` before the step. |
| Shallow clone | **NOT CURRENTLY SUPPORTED** *(detected)* | Use `actions/checkout` with `fetch-depth: 0`. |

## Repository layout

| Configuration | Status | Notes |
| --- | --- | --- |
| One package at the repository root | **SUPPORTED** | |
| Monorepo, one project analysed via `workingDirectory` | **LIMITED** *(warned)* | Only that directory is analysed; changes elsewhere are not verified. In protected CI the value comes from the base-branch policy. |
| Monorepo with several projects analysed in one run | **NOT CURRENTLY SUPPORTED** | Run the Action once per project directory, each with its own `workingDirectory`, or wait for multi-project support. |

## Test discovery

| Configuration | Status | Notes |
| --- | --- | --- |
| Default naming (`*.test.*`, `*.spec.*`, `__tests__/`) | **SUPPORTED** | |
| Static Jest `testMatch` (list of strings) | **SUPPORTED** | |
| Static Vitest `test.include` / `test.dir` | **SUPPORTED** | |
| Jest `testRegex`, `projects`; Vitest workspaces/`projects`; dynamic or spread configs | **LIMITED** *(detected)* | MI107 (advisory warning) on every run; only default naming is analysed, so some test files may be missed. Calibration: 9 PRs, 3 repositories. |
| Configuration reachable only through the test script (`jest --config path/to/config.js` with no root config) | **NOT CURRENTLY SUPPORTED** *(detected)* | The gate starts the runner itself and would use a different configuration; runs ERROR. Calibration: react-hook-form ×3. |

## How tests are started

The gate runs the installed `jest`/`vitest` binary directly with its own flags. It does **not** run your `test`
script, so anything that script sets up is not applied.

| Configuration | Status | Notes |
| --- | --- | --- |
| `test` script is a plain `jest` / `vitest run` invocation (with or without `--coverage`) | **SUPPORTED** | |
| `test` script sets environment variables (`TZ=…`, `cross-env …`) | **LIMITED** *(detected)* | Set them on the workflow job and list the names under `testEnvironment.passthrough`. Calibration: luxon (as a job-level env, which cannot be detected statically). |
| `test` script passes `--color=true` and snapshots contain colour codes | **LIMITED** *(detected)* | The gate always runs without colour, so those snapshots do not match. Calibration: jest-extended #885. |
| `test` script runs a build first (`npm run build && jest`) or a `pretest` script | **LIMITED** *(detected)* | Red/green runs in a clean worktree with no build step; those tests become MI103 (advisory). |
| `test` script is a custom runner (`node scripts/test.js`, `turbo test`, `nx test`) | **LIMITED** *(detected)* | The gate still runs the framework binary; if the framework cannot run the files alone, results are advisory or ERROR. |

## Test execution requirements (red/green verification)

| Requirement | Status | Notes |
| --- | --- | --- |
| Tests run from a clean checkout with dependencies installed | **SUPPORTED** | |
| Tests need generated files, a build step, or untracked files | **NOT CURRENTLY SUPPORTED** | Reported as MI103 (advisory warning) or ERROR, never as PASS. Not statically detectable in general. |
| Tests need environment variables the workflow does not provide | **NOT CURRENTLY SUPPORTED** | Provide them on the job and list them in `testEnvironment.passthrough`. Not statically detectable when they come from CI. Calibration: luxon #1787. |
| Tests need external services (database, network) | **LIMITED** | Works if the workflow provides them; the gate itself makes no network calls. |
| Tests that write into `node_modules` during a run | **NOT CURRENTLY SUPPORTED** | Detected at runtime and reported as ERROR (integrity of the dependency tree). |
| Very slow test files | **LIMITED** | Red/green has a time budget (`redGreen.timeoutSeconds`, default 120 s); exceeding it is ERROR. Calibration: node-cron #607. |
| Symlinked test files | **NOT CURRENTLY SUPPORTED** | ERROR by design (path safety). |

## Platform and CI

| Configuration | Status | Notes |
| --- | --- | --- |
| GitHub Actions, `pull_request` and `merge_group` | **SUPPORTED** | |
| GitHub-hosted Ubuntu runners | **SUPPORTED** | All calibration and GitHub validation runs. |
| Self-hosted runners | **LIMITED** | Works, but the gate runs the pull request's tests: see [SECURITY.md](../SECURITY.md#operating-guidance). |
| Windows and macOS runners | **LIMITED** | The test suite runs on Windows during development; no CI evidence on macOS. |
| `pull_request_target` | **NOT CURRENTLY SUPPORTED** | Refused by design (privileged token with untrusted code). |
| GitLab, Bitbucket, Jenkins, CircleCI | **NOT CURRENTLY SUPPORTED** | The CLI can run anywhere Node and Git are available, but nothing is integrated or validated. |
| Node 22.18+ / 24.11+ | **SUPPORTED** *(detected)* | Other versions are refused. |

## Mutation testing (optional, off by default)

| Configuration | Status | Notes |
| --- | --- | --- |
| `@stryker-mutator/core` 10 with Jest 27–30 | **SUPPORTED** *(detected)* | Enable with `mutation.enabled: true`. |
| `@stryker-mutator/core` 10 with Vitest 2–4 | **SUPPORTED** *(detected)* | |
| Vitest 5, other Stryker majors | **NOT CURRENTLY SUPPORTED** *(detected)* | ERROR when mutation is enabled; the preflight warns when it is not. |

## What the preflight cannot know

A static preflight reads the repository; it does not run your tests or your CI. It therefore cannot detect:

- environment variables your CI workflow sets for the test job;
- services, fixtures or credentials your tests need at runtime;
- generated files produced outside a `pretest`/`test` script;
- tests that are slow enough to exceed the red/green budget;
- flaky tests.

These appear as ERROR or MI103 on the first real run. ERROR is never reported as PASS.
