# Security Policy

AI Test Integrity Review executes the tests of pull requests that may be untrusted. Its security model is
designed around that fact.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately through GitHub's
"Report a vulnerability" (private vulnerability reporting) on this repository. Include the affected version,
a reproduction, and the impact. We aim to acknowledge reports within 5 business days.

Status: pre-release alpha (`v0.1.0-alpha.1`). Only the latest commit on `main` is supported; there are no
backported fixes.

Related: [PRIVACY.md](PRIVACY.md) (what happens to your code), [SUPPORT.md](SUPPORT.md) (non-security issues,
and what never to paste into one).

## Security model (summary)

| Property | How it is enforced |
| --- | --- |
| No LLM, no prompt injection surface | There is no runtime model or agent. Repository text is parsed deterministically and treated as data only. |
| No source upload, no telemetry | The analyser makes no network calls (tested by intercepting sockets, HTTP, DNS and `fetch`). Stryker runs with the JSON reporter only; its dashboard reporter is never enabled. |
| No secrets required | The Action needs no token or secret. Recommended permissions: `contents: read`. |
| Unprivileged PR context | The Action refuses `pull_request_target`. Use `pull_request` and `merge_group`. |
| PR cannot weaken its own gate | On `pull_request`/`merge_group`, refs come only from event metadata and inputs that would change refs, config source/path, working directory, framework, run mode (`mode: doctor` would make the gate a no-op), or disable stages make the run ERROR. Policy (`.merge-integrity.yml`) is always loaded from the base revision there; a PR that weakens the policy or edits how the gate runs (YAML-parsed: inputs, `if`, `continue-on-error`, triggers, Action repository) is BLOCKed (MI106); removing the gate is MI005. Workflow replacement needs repository protection (below). |
| Isolated verification runs | Every test execution uses a fresh worktree and a fresh HOME/TMP/cache sandbox; installed dependencies are fingerprinted and any modification during a run is ERROR. |
| No shell injection | Every process is spawned with an argument array and `shell: false` (enforced by lint rules). Git receives refs after `--end-of-options`, paths after `--`, and `GIT_LITERAL_PATHSPECS=1`. |
| Path traversal / symlinks | Paths from Git are validated as contained, relative POSIX paths. Files written into worktrees come from Git objects, never from the working tree, and are refused if any parent is a symlink. Symlinked test files cause ERROR. |
| Runner privilege isolation | Child processes that run repository code (tests, Stryker) receive an **allowlisted** environment: OS/Node variables (`PATH`, locale, `TZ`, `NODE_OPTIONS`, Windows system variables, `CI`), a sandboxed HOME/TMP, and only the variable names the base policy lists in `testEnvironment.passthrough`. `ACTIONS_*`, `INPUT_*`, `GITHUB_TOKEN`, step file-command paths and other runner-privileged names can never be passed. `node` and `git` are resolved to absolute paths from PATH, ignoring relative entries and repository directories. Untrusted text is printed only while workflow commands are suspended (`::stop-commands::`), and annotations are escaped. |
| Resource exhaustion | Per-stage time budgets, process-tree termination, output size caps, file size limits, max mutant budget. |
| Cleanup | Temporary worktrees are removed in `finally`, and on SIGINT/SIGTERM. Dependency links are removed before any recursive delete. |
| Fail closed | Any analysis failure is ERROR (exit 2). ERROR is never rendered or mapped as PASS. |

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full threat model and residual risks.

## Operating guidance

1. **Use GitHub-hosted runners for public repositories.** The gate runs the pull request's tests.
   On a self-hosted runner those tests can access whatever the runner can access (files, network, cloud
   credentials). Do not run untrusted fork PRs on self-hosted runners unless you accept that risk.
2. **Use `actions/checkout` with `persist-credentials: false`.** Otherwise the job token is stored in
   `.git/config`, where the pull request's tests can read it.
3. **Do not add secrets to the job** that runs Merge Integrity.
4. **Protect the workflow file (required repository configuration).** With `pull_request`, GitHub runs the
   workflow definition from the pull request itself. Inside that run, Merge Integrity refuses weakening inputs
   (ERROR) and reports gate edits (MI005/MI106, BLOCK). But if a PR deletes the step or replaces the workflow,
   **the gate does not run at all**, and a job with the same name can still succeed. The Action cannot prevent
   this on its own. Configure all of the following on the protected branch:
   1. A branch ruleset (or branch protection) that requires the `merge-integrity` status check, requires a pull
      request review, and does not allow bypass (including administrators).
   2. `CODEOWNERS` entries for `/.github/workflows/` and `/.merge-integrity.yml` owned by maintainers, with
      "Require review from Code Owners" enabled. A PR that touches the gate then needs maintainer approval,
      and that PR is BLOCKed by MI005/MI106 until a maintainer deliberately overrides it.
   3. Strongest option (GitHub organisations): a repository ruleset with **Require workflows to pass before
      merging**, pointing to a Merge Integrity workflow stored in a separate, protected repository. Required
      workflows run from that repository's ref, so a pull request cannot edit or remove them, and a same-named
      job in another workflow cannot satisfy them.
5. **Trust the check status, not step outputs.** Outputs such as `status` are informational; a malicious
   test could attempt to tamper with runner files. Do not feed outputs into privileged later steps.
6. **Isolate network access for tests** where practical. Merge Integrity makes no network calls itself, but
   the project's own tests may.

## Supply chain

- Runtime dependencies bundled into the Action: `@babel/parser` (MIT), `picomatch` (MIT), `yaml` (ISC).
  Checked by `node scripts/check-licenses.mjs`.
- Jest, Vitest and Stryker are never bundled; they are resolved from the analysed project.
- Dependency install scripts are denied by default (`allowBuilds` in `pnpm-workspace.yaml`).
- Lockfile is committed; CI installs with `--frozen-lockfile`.
- Third-party Actions in this repository's workflows are pinned by commit SHA.
- Dependabot (npm and GitHub Actions) and CodeQL are configured in `.github/`.
