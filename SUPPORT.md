# Support

This is an **unpublished alpha** maintained by one person. Support is best-effort and GitHub-native: there is no
inbox, no chat and no SLA.

## Before opening an issue

1. Run the preflight and read its output: add the Action with `mode: doctor` to a `workflow_dispatch` workflow
   (see [examples/github-workflow-preflight.yml](examples/github-workflow-preflight.yml)), or build this
   repository and run `node packages/cli/dist/main.js doctor --format json` against your project.
2. Check [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — it covers the problems seen most often in
   calibration.
3. Check [docs/ALPHA_SUPPORT_MATRIX.md](docs/ALPHA_SUPPORT_MATRIX.md). If your setup is
   **NOT CURRENTLY SUPPORTED**, that is a known gap, not a defect in your repository. An issue is still welcome:
   it tells us which gaps to close first.

## Opening an issue

Use *Issues → New issue* and pick a form:

| Form | Use it when |
| --- | --- |
| **Incorrect finding** | A BLOCK or WARN you believe is wrong. **Highest priority** — a false BLOCK is the worst defect this product can have. |
| **Compatibility / ERROR** | The check ERRORs, or cannot analyse your repository. |
| **Useful finding** | It caught something real, or the evidence helped a review. This is what tells us the product is worth continuing. |
| **Alpha feedback** | Anything else: noise, speed, wording, what would make you uninstall it. |

The forms live in [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/).

## Never paste into an issue

- secrets, tokens, credentials or environment files;
- private or proprietary source code;
- internal logs, customer data, or anything covered by an NDA.

Rule IDs, framework and package-manager names, versions, and a short redacted snippet are enough. If a full log
is genuinely needed, we will ask and you can redact it first. **Everything in a public issue is public forever.**

## Security issues

Do **not** open a public issue. Use GitHub's private vulnerability reporting — see [SECURITY.md](SECURITY.md).

## Response expectations

- Security reports: acknowledged within 5 business days.
- False-BLOCK reports: looked at first, before features.
- Everything else: when time allows. Alpha issues may be closed as "known gap" with a pointer to the support
  matrix.

## Turning it off

You never need our help to stop using it: remove `merge-integrity` from the required status checks, or delete the
workflow file. Nothing else is installed and no data is retained anywhere — see [PRIVACY.md](PRIVACY.md).
