# Troubleshooting

Each entry is SYMPTOM → CAUSE → WHAT TO DO → SUPPORTED / UNSUPPORTED.
Run the preflight first — the Action with `mode: doctor`, or `merge-integrity doctor` locally. It detects
most of the problems below before a run ([INSTALL.md](INSTALL.md#preflight-first)).

Quick reading of a result:

| Result | Meaning | Job |
| --- | --- | --- |
| **PASS** | No blocking integrity finding. | success |
| **WARN** | Advisory evidence to review. | success (by default) |
| **BLOCK** | High-confidence test tampering. | failure |
| **ERROR** | The analysis could not safely complete. **Not** a claim that the pull request is safe. | failure |

---

## 1. Every run ERRORs: "jest/vitest is not installed in the project"

**SYMPTOM** ERROR on every pull request; the log mentions the test runner not being installed.

**CAUSE** Either dependencies were not installed before the Merge Integrity step, or the project uses **Yarn
Plug'n'Play**, which does not create a `node_modules` tree at all.

**WHAT TO DO**
- Add `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable` *before* the Merge Integrity step.
- If `.yarnrc.yml` exists, check `nodeLinker`. Yarn ≥ 2 uses Plug'n'Play unless it says `nodeLinker: node-modules`.

**UNSUPPORTED** — Yarn Plug'n'Play. Switching to `nodeLinker: node-modules` makes the repository supported;
otherwise wait for PnP support.

---

## 2. Vitest browser mode: ERROR on browser test files

**SYMPTOM** ERROR when a pull request changes tests that run in a browser project.

**CAUSE** The gate runs Vitest directly in Node. Test files belonging to a `browser: { enabled: true }` project
cannot be executed or verified this way.

**WHAT TO DO** Point the gate at a project directory whose tests run in Node, or leave the check unenforced
until browser-mode support exists.

**UNSUPPORTED** — detected by the preflight.

---

## 3. ERROR only in one repository: Jest configuration lives in the test script

**SYMPTOM** ERROR such as "no tests found" or a configuration error, while `npm test` works locally.

**CAUSE** The project's `test` script passes the configuration (`jest --config ./scripts/jest/jest.config.js`).
The gate starts Jest itself, without those flags, so Jest falls back to default configuration.

**WHAT TO DO** Move the configuration to a root-level `jest.config.*` file, or a `"jest"` field in
`package.json`, so that plain `jest` finds it.

**UNSUPPORTED** as configured — **SUPPORTED** once the configuration is discoverable.

---

## 4. Snapshot tests fail only under the gate

**SYMPTOM** Tests using snapshots fail or are reported inconclusive under Merge Integrity but pass in the
project's own CI.

**CAUSE** The project's `test` script passes `--color=true` (or similar) and the snapshots contain ANSI colour
codes. The gate always runs with colour disabled, so the snapshots do not match.

**WHAT TO DO** Regenerate the affected snapshots without colour, or accept the advisory warnings on those tests.

**LIMITED** — the run completes; those specific tests give no red/green evidence.

---

## 5. MI107: "test discovery cannot be analysed"

**SYMPTOM** `MI107_TEST_DISCOVERY_UNSUPPORTED` warning on every pull request.

**CAUSE** Discovery settings that cannot be read without executing repository code: Jest `testRegex` or
`projects`, Vitest workspaces/`projects`, or a dynamically built config. Only default test-file naming is then
analysed, so some test files may not be seen.

**WHAT TO DO** Use standard `*.test.*` / `*.spec.*` names or a static `testMatch` / `test.include` list. If the
configuration cannot change, the warning is informational: it says coverage of your test files is incomplete.
It does not fail the check by default; you can silence it with an `ignore` entry in `.merge-integrity.yml`.

**LIMITED** — supported with reduced coverage.

---

## 6. MI103: "changed test could not be verified"

**SYMPTOM** `MI103_RED_GREEN_INCONCLUSIVE` warnings, often several per pull request.

**CAUSE** The changed test could not be run against the base implementation to see whether it fails there.
Common reasons: the test needs a build step, generated or untracked files, environment variables, or a service;
the test file imports something that does not exist on the base; the test is slow; the test's identity is
generated at runtime.

**WHAT TO DO** Treat it as "no evidence", not as a problem with the pull request. It is advisory by default. If
it appears on nearly every pull request, the repository is probably in a LIMITED row of
[ALPHA_SUPPORT_MATRIX.md](ALPHA_SUPPORT_MATRIX.md) — tell us: open a
**Compatibility / ERROR report** issue (see [SUPPORT.md](../SUPPORT.md)).

**LIMITED** — the check still runs; this particular test gives no evidence.

---

## 7. Tests need `TZ`, `LANG` or other environment variables

**SYMPTOM** ERROR or many failures on the base revision only under the gate; the project's own CI sets variables
for the test job.

**CAUSE** Tests run with a deliberately minimal environment. Runner-privileged variables are never passed, and
project variables are passed only when the base-branch policy lists them.

**WHAT TO DO** Set the variables on the workflow job, then list their **names** in `.merge-integrity.yml`:

```yaml
version: 1
testEnvironment:
  passthrough: ["TZ", "LANG", "DATABASE_URL"]
```

`ACTIONS_*`, `INPUT_*`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` can never be passed.

**SUPPORTED** once the names are listed.

---

## 8. Timeout: "red/green budget exceeded"

**SYMPTOM** ERROR mentioning the red/green time budget, usually on repositories with slow tests.

**CAUSE** Verification runs the changed test files twice (head code, then base code) inside the budget
(`redGreen.timeoutSeconds`, default 120 s in total).

**WHAT TO DO** Raise the budget in the base-branch policy, or reduce what the changed test files do at import
time. If a single test file cannot run in the budget, red/green cannot be used for it.

```yaml
version: 1
redGreen:
  timeoutSeconds: 300
```

**LIMITED**.

---

## 9. The check fails and I do not understand why (ERROR vs BLOCK)

**SYMPTOM** A red check with no rule ID.

**CAUSE** ERROR means the analysis could not complete: unsupported setup, environment problem, or an internal
error. It is not a statement about the pull request.

**WHAT TO DO** Read the "Reason" line in the job log or the Step Summary, then find it in this document. ERROR
never becomes PASS by design; if the cause cannot be fixed, remove the check from required status checks until
the repository is supported.

---

## 10. Merge Integrity blocked my pull request and I believe it is wrong (MI001/MI002/MI004/MI005/MI106)

**SYMPTOM** BLOCK on a pull request you consider legitimate.

**CAUSE** One of the five high-confidence rules fired: a test was skipped or focused, an assertion was weakened
in a reviewed transformation, the test command was bypassed, or the gate/policy itself was changed.

**WHAT TO DO**
1. Read the annotation: it names the file, line and the exact transformation.
2. If the change is intentional (for example a test removed with the feature), a maintainer can merge it
   deliberately, add an `ignore` entry scoped to that path with a reason, or set the rule to `warn` in the
   base-branch policy.
3. **If you believe the finding is wrong, please report it** — a false BLOCK is the most serious defect this
   product can have. Open an **Incorrect finding** issue (see [SUPPORT.md](../SUPPORT.md)).

---

## 11. The workflow does not run, or the Action cannot be found

**SYMPTOM** No check appears on the pull request, or "Unable to resolve action".

**CAUSE** The alpha is installed from a commit SHA of a repository you must be able to read; the workflow may
also be missing a trigger, or the repository may have Actions disabled.

**WHAT TO DO**
- Check `on: pull_request` (and optionally `merge_group`) is present.
- Pin the Action by full commit SHA: `uses: muhammadmirza97/ai-test-integrity-review@<40-char-sha>`.
- Confirm Actions are enabled: *Settings → Actions → General*.
- For fork pull requests, workflow runs may need approval.

---

## 12. Permissions: the job fails before Merge Integrity runs

**SYMPTOM** Checkout or setup fails, or annotations do not appear.

**CAUSE** The workflow needs only `contents: read`; a restrictive default or an organisation policy can remove it.

**WHAT TO DO** Use exactly:

```yaml
permissions:
  contents: read
```

Do **not** add secrets to this job, and use `persist-credentials: false` on checkout. `pull_request_target` is
refused by design.

---

## 13. I want to turn it off

- **Stop enforcing:** remove `merge-integrity` from the required status checks (*Settings → Rules/Branches*).
- **Stop running:** delete `.github/workflows/merge-integrity.yml`.
- **Keep it advisory:** leave the defaults; only MI001, MI002, MI004, MI005 and MI106 fail a check.

Nothing is left behind: there is no account, no backend and no data to delete. See [PRIVACY.md](../PRIVACY.md).
