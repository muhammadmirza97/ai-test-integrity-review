# Technical Architecture

## Architectural objective

Keep the MVP local-first, deterministic, cheap to operate, easy to understand, and difficult to misuse.

## Three-tier model

### Tier 1 — Interface

- CLI terminal output
- GitHub Action job status
- GitHub Step Summary
- workflow annotations
- optional JSON report

No dashboard.

### Tier 2 — Analysis/application

Local modules:

- repository context discovery
- Git diff analysis
- framework detection
- AST parsing
- deterministic rule engine
- red/green verifier
- mutation adapter
- policy evaluator
- report renderer
- GitHub Action wrapper

### Tier 3 — Data/infrastructure

MVP only:

- local Git repository
- temporary Git worktrees
- ephemeral JSON report
- GitHub runner or developer workstation

No application database.

## Recommended repository structure

```text
/
├─ action.yml
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ README.md
├─ SECURITY.md
├─ docs/
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ domain/
│  │  │  ├─ git/
│  │  │  ├─ framework/
│  │  │  ├─ ast/
│  │  │  ├─ rules/
│  │  │  ├─ red-green/
│  │  │  ├─ mutation/
│  │  │  ├─ policy/
│  │  │  └─ report/
│  │  └─ test/
│  ├─ cli/
│  │  ├─ src/
│  │  └─ test/
│  └─ action/
│     ├─ src/
│     ├─ test/
│     └─ dist/
└─ test-repos/
   ├─ jest-basic/
   └─ vitest-basic/
```

## Core domain

```ts
export type Severity = "warn" | "block";
export type OverallStatus = "pass" | "warn" | "block" | "error";

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  evidence?: Record<string, unknown>;
}

export interface AnalysisReport {
  status: OverallStatus;
  findings: Finding[];
  ignoredFindings: Finding[];
  redGreen: RedGreenSummary;
  mutation: MutationSummary;
  durationMs: number;
  error?: AnalysisError;
}
```

Rules emit findings. Policy evaluation decides the overall status.

## Analysis pipeline

```text
load config
→ validate environment
→ resolve base/head
→ compute diff
→ detect test framework
→ parse changed source/test/config
→ deterministic rules
→ head tests
→ red/green verification
→ targeted mutation testing
→ apply ignore policy
→ evaluate severity policy
→ render output
```

## AST strategy

Prefer:

- `@babel/parser`
- `@babel/traverse`

Use ASTs for semantic test analysis.

Use regex/text matching only for simple deterministic script/config checks.

No full TypeScript type-analysis requirement in MVP.

## Test runner adapter

One internal abstraction:

```ts
interface TestRunnerAdapter {
  framework: "jest" | "vitest";
  runFiles(args: {
    cwd: string;
    files: string[];
    timeoutMs: number;
  }): Promise<TestRunResult>;
}
```

Results must distinguish:

- pass
- assertion failure
- snapshot failure
- compile/import error
- setup/config error
- timeout
- crash

## Red/green isolation

Use temporary Git worktrees.

Never repeatedly checkout the user's current working tree.

Always clean temporary worktrees in `finally`.

Never overlay arbitrary untracked files or `.env` files.

## Mutation

Use StrykerJS behind an adapter.

The rest of the system must not depend on Stryker-specific data structures.

Mutation is targeted to changed production files/lines and limited by time and mutant count.

Surviving mutants are WARN by default.

## Commercial architecture later

Only after validation:

- small control plane
- GitHub auth
- Stripe
- managed PostgreSQL
- entitlements and usage
- no repository source storage

Do not pre-build that architecture.
