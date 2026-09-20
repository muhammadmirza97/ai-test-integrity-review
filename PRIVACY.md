# Privacy

This describes the product as it exists today: a GitHub Action and a local CLI. Nothing here is a promise about
a future hosted version; if one is ever built, this file will change before it ships.

## The short version

**We receive nothing.** There is no server, no account, no database and no telemetry. The analysis runs entirely
inside your GitHub Actions runner (or your own machine) and writes its result into that job.

## What the software does with your code

| | |
| --- | --- |
| Reads your repository | Yes — files at the base and head revisions of the pull request, from the local Git checkout. |
| Executes your tests | Yes — the changed test files, in a temporary worktree on the same runner, to check whether they fail on the base implementation. Optionally Stryker, if you enable mutation testing. |
| Sends your code anywhere | **No.** The analyser makes no network requests. This is enforced architecturally and verified by a test that intercepts `net.Socket.connect`, `http.request`, `https.request`, `dns.lookup` and `fetch` during a full analysis (`packages/core/test/integration/check-deterministic.test.ts`). |
| Uses an LLM or AI service | **No.** There is no model, hosted or local, anywhere in the product. |
| Collects telemetry, analytics, usage counts or "phone home" pings | **No.** None exists, and none is planned for the alpha. |
| Requires an account, licence key or sign-up | **No.** |
| Requires a GitHub token or any secret | **No.** The recommended workflow uses `permissions: contents: read` and no secrets. |
| Reads your GitHub issues, pull-request comments or repository metadata beyond the event | **No.** Base and head commit SHAs come from the workflow event payload. |

## What is produced, and where it stays

| Output | Where it lives | Who can see it |
| --- | --- | --- |
| Job log (findings, file/line, short code snippets from the diff) | The workflow run log | Anyone who can see the run — on a public repository, that is everyone |
| Step Summary (the same information, formatted) | The workflow run page | Same |
| Annotations on the pull-request diff | The pull request | Same |
| `report.json` | `RUNNER_TEMP` on the runner | Deleted with the runner unless *you* upload it as an artifact |
| Temporary worktrees and caches | A sandboxed temporary directory on the runner | Removed when the run ends, including on interrupt |

Findings quote small excerpts of the changed code (for example the assertion before and after). On a public
repository those excerpts are already public. On a private repository they stay inside your repository's run
logs; nothing leaves it.

## The CLI

`merge-integrity check` and `merge-integrity doctor` run locally. They read the repository, may run your tests,
and print to your terminal (plus a JSON file if you pass `--output`). Nothing is transmitted.

## Third-party data flows

The Action itself contacts nothing. The rest of your workflow is yours: `actions/checkout` and
`actions/setup-node` talk to GitHub, your package manager talks to your registry, and **your own tests** may do
anything they normally do, including network access. Merge Integrity runs them in a deliberately restricted
environment (see [SECURITY.md](SECURITY.md)), but it does not sandbox the network.

## Environment variables

Tests started by the gate receive an allowlisted environment: OS/Node variables, a sandboxed `HOME`/`TMP`, plus
exactly the variable names the base-branch policy lists in `testEnvironment.passthrough`. `ACTIONS_*`, `INPUT_*`,
`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` and step file-command variables are never passed —
so a pull request's tests cannot read the job token through this product.

## If you report an issue

Issues are public GitHub issues. Only you decide what goes into them. The issue forms ask you **not** to paste
secrets, tokens, private source code or proprietary logs, and the information requested (framework, package
manager, versions, rule IDs, PASS/WARN/BLOCK/ERROR) is deliberately non-sensitive. See [SUPPORT.md](SUPPORT.md).

## Data we hold about you

None. There is nothing to export, and nothing to delete. Uninstalling means removing a workflow file.

## What this document does not do

It does not make legal or regulatory guarantees (GDPR, CCPA, SOC 2 or any certification). It is a factual
description of what the code does, which you can verify in the source — that is the only claim being made.

## Changes

This file is versioned with the product. Any change in data handling must land in the same pull request as the
code that changes it.
