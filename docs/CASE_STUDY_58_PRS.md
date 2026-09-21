# We tested an AI test-integrity gate against 58 real merged pull requests. It failed — so we changed the product.

This is the calibration story behind [AI Test Integrity Review](https://github.com/muhammadmirza97/ai-test-integrity-review).
Every number here comes from a run that is written down in this repository:
[CALIBRATION_RESULTS.md](../CALIBRATION_RESULTS.md) and
[POLICY_RECALIBRATION.md](../POLICY_RECALIBRATION.md).

## The hypothesis

An AI coding agent that cannot make a failing test pass can always make the test stop asking. Delete the
assertion, add `.skip`, widen `toBe(42)` to `toBeDefined()`, narrow the test command — the suite goes green
either way, and a human reviewer sees a green check.

So: write a deterministic check that looks at the diff, decides whether the tests were weakened, and **fails
the build** when they were. Fail closed, like a type checker or a linter. If the analysis cannot complete, fail
too — a false PASS is the worst possible outcome for a tool whose entire job is to tell you the green check
means something.

That reasoning is sound and the result was unusable. Here is why.

## Why strict fail-closed sounded right

Three arguments made it attractive, and each one is defensible on its own:

1. **A false PASS is worse than a false BLOCK.** If the tool says "fine" when tests were gutted, it is worse
   than useless — it launders the problem.
2. **Determinism beats judgement.** No model, no scoring, no "confidence 0.72". A rule either fires or it does
   not, and you can read the rule.
3. **Merge gates are how the industry enforces anything.** Required status checks are the only mechanism that
   reliably changes behaviour on GitHub.

What none of that tells you is how often the rules fire on *normal, accepted work*. That is an empirical
question, and it has an empirical answer.

## The calibration

58 merged pull requests from 15 public repositories — `ts-pattern`, `luxon`, `class-validator`, `cron-parser`,
`jest-extended`, `react-hook-form`, `es-toolkit`, `zustand`, `jotai`, `cheerio`, `Fuse`, `reselect`, `axios`,
`node-cron`, `ufo` — 24 Jest and 34 Vitest, split across 32 pull requests that changed tests, 14
production-only and 12 tooling-only.

Selection was mechanical: actively maintained single-package JS/TS libraries with a committed lockfile; each
repository's merged pull requests walked newest-first; the first few of each category taken. No hand-picking,
and dependency-bot pull requests were **not** excluded. Each pull request ran in its own disposable
GitHub-hosted job with `permissions: {}` and no secrets.

These are pull requests that maintainers reviewed and merged. That is not the same as "correct" — merged code
contains bugs, and a weakened test can absolutely be merged. But it is the best available proxy for *work a
maintainer accepted*, and a gate that fails a large share of accepted work is not adoptable, whatever else is
true about it.

## What the strict policy actually did

| Result | Pull requests | Share |
| --- | --- | --- |
| PASS | 27 | 46.6% |
| WARN | 13 | 22.4% |
| **BLOCK** | **7** | **12.1%** |
| ERROR | 11 | 19.0% |

As a required status check, that is **31 of 58 accepted pull requests red (53%)**. Of the 32 pull requests that
touched tests — exactly the ones the product exists to judge — only 5 would have been green.

**All 7 BLOCKs were false.** Zero true positives. They came from three causes:

- **Per-test MI006 on companion tests.** The rule says: a regression test that passes on the old code as well
  as the new one has not demonstrated anything. True in isolation — but real pull requests add *guard* tests
  alongside the regression test, and those correctly pass on both sides. Judged per test, the honest pull
  request looks guilty.
- **A defect (D1) in changed-test identity.** Tests whose names are generated at runtime, or duplicated within
  a file, were treated as "changed" whenever anything else in the file changed, so unchanged tests were held to
  the regression-test standard.
- **MI003 on deliberate removal.** Two pull requests removed a feature and its assertions on purpose. The diff
  looks identical to weakening; the intent is the opposite.

The warnings were noisy in their own way: **MI103** ("could not verify this changed test") appeared on 14
pull requests, **MI107** ("test discovery cannot be read statically") on 8 across 3 repositories, MI006 on 5,
MI104 on 4, MI003 on 2. Under the strict policy those warnings failed protected runs too.

And 11 runs ended in **ERROR**: 8 from repository setups the analyser could not handle (Yarn Plug'n'Play with
no `node_modules`; a Jest config reachable only through the `test` script; snapshots that depend on the test
script's `--color=true`; a Vitest browser-mode project), 1 from a product defect (D2 — `BigInt` values crashed
canonicalisation), 1 environment (tests needing `TZ`/`LANG` that the project's own CI provides) and 1 that
exceeded the red/green time budget.

The honest summary: **on this sample the tool turned red on more than half of the work maintainers had already
accepted, and caught nothing.** A team would learn within days that red means "the tool could not cope", and
would either make the check non-required or bury it in ignore rules. Both destroy the guarantee the check
exists to provide.

## What we changed

The instinct is to tune thresholds. We changed the product's claim instead.

**Blocking is now reserved for high-confidence tampering**, and that is a short list: a test gains `.skip` or
`.only`, an assertion is weakened in one of a set of reviewed transformations on a uniquely matched test, the
test command is bypassed, or the gate itself is weakened. Five rules.

**Everything uncertain became advisory.** Removed assertions, non-discriminating regression tests,
unverifiable tests, unreadable discovery, surviving mutants — all of it is now a warning that does not fail the
check. The rule that failed protected runs on MI103/MI107 was withdrawn entirely.

Two defects were fixed: **D1** (changed tests are now matched by fingerprint per test key, with a context
signature so a test whose identity is not unique counts as changed only when its own code or case data
changes) and **D2** (`BigInt` canonicalisation).

Then the same 58 pull requests were re-scored, and 23 of them fully re-run on the fixed build.

## The result

| Measure | Strict policy | Recalibrated |
| --- | --- | --- |
| PASS | 27 | 28 |
| WARN | 13 | 19 |
| **BLOCK** | **7** | **0** |
| ERROR | 11 | 11 |
| Protected check red | **31 of 58 (53%)** | **11 of 58 (19%)** |
| False BLOCKs | **7** | **0** |

The five blocking rules fired on **none** of the 58 accepted pull requests.

### What that does and does not prove

It does **not** prove a 0% false-positive rate. With zero events in 58 samples, the 95% upper bound on the
per-pull-request false-BLOCK rate is roughly **5%** (the rule of three). It is a bound, not a guarantee, on one
non-random sample of library-sized repositories.

It says nothing at all about **recall**. The corpus contained no known tampering, so it cannot show how much
real test-gaming these rules catch. The only detection evidence today is rule fixtures and 18 synthetic
tampering scenarios, all of which pass. That gap is the main reason the product is in alpha.

The remaining 11 red checks are all ERROR, and 9 of those are repository setups the analyser does not support.
Which brings us to the second change.

## Fail fast instead of failing late

If one in five runs ends in ERROR because of the repository's setup, the fix is not to guess — it is to say so
before anyone installs anything. So the compatibility preflight became a first-class feature:

```yaml
- uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.1
  with:
    mode: doctor
```

It reads the repository — no tests run, no repository code executed — and answers **SUPPORTED**,
**SUPPORTED WITH WARNINGS** or **UNSUPPORTED**, with a reason and a remedy for every finding: package manager
and Yarn Plug'n'Play, Vitest browser mode, a config reachable only through the `test` script, unreadable test
discovery, framework version, missing dependencies, shallow clones, mutation-testing compatibility.

Reproducing the real configuration of the repositories that ERRORed in calibration, the preflight identifies
**9 of those 11 pull requests as UNSUPPORTED before anything runs**, and names a tenth as a warning. The last
one needs runtime facts (a `TZ` the project's CI provides; a test slower than the red/green budget) that no
static check can see, and the support matrix says so rather than pretending otherwise.

## What the alpha does today

```text
PR diff
→ deterministic test-integrity rules (skip, only, removed/weakened assertions, command bypass, policy tampering)
→ red/green verification: each changed test is run against the base implementation in a fresh, isolated worktree
→ optional targeted mutation testing on changed production lines
→ PASS / WARN / BLOCK / ERROR
```

- **PASS** — no blocking integrity finding.
- **WARN** — advisory evidence for a reviewer; does not fail the check.
- **BLOCK** — high-confidence tampering; fails the check.
- **ERROR** — the analysis could not safely complete. It is not a claim that the pull request is safe, and it
  is never reported as PASS.

The part we think is genuinely useful is the middle step: a regression test that is supposed to prove a fix has
to **fail on the old code with a real assertion failure** and pass on the new one. In calibration that
evidence was produced for 8 pull requests across 6 repositories, typically in about ten seconds.

Cost of running it: the gate step took a median of 0.6 s, p90 21 s, maximum 121 s; a run that includes
red/green took about 10 s at the median. There is no backend, no account, no telemetry and no LLM — the
analysis runs entirely on your runner, and the repository's code never leaves it.

## Honest limits

- **Recall is unmeasured.** No field evidence that it catches real tampering.
- **Jest 29–30 and Vitest 4–5, JavaScript/TypeScript, GitHub Actions, one project directory per run.**
- **Not supported:** Yarn Plug'n'Play, Vitest browser mode, a config reachable only through the `test` script,
  multi-project runs. Run the preflight — it will tell you in a minute.
- **Advisory findings are frequent** on repositories whose test discovery cannot be read statically.
- **It does not prove a pull request correct or safe**, it does not detect whether code was written by an AI,
  and it does not catch every way a test can be gamed.
- Enforcement as a *required* check has not been proven end to end. Run it unenforced.

## Try it on real work

The thing we cannot manufacture is evidence from real repositories doing AI-assisted development.

```yaml
name: Test Integrity
on: pull_request
permissions:
  contents: read
jobs:
  test-integrity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.1
```

Run the preflight first, leave it **unenforced** while you evaluate, and tell us what happened —
[the issue forms](https://github.com/muhammadmirza97/ai-test-integrity-review/issues/new/choose) take a few
minutes and none of them need your source code. A finding you believe is wrong is the single most valuable
thing you can report: a false BLOCK is the most serious defect this product can have, and the last time we
found seven of them we rewrote the policy.

Apache-2.0 · [repository](https://github.com/muhammadmirza97/ai-test-integrity-review) ·
[install](INSTALL.md) · [support matrix](ALPHA_SUPPORT_MATRIX.md) ·
[full calibration data](../CALIBRATION_RESULTS.md)
