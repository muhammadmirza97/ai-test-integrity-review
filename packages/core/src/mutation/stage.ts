import { untrustedEnv } from "../process/env.js";
import { resolveExecutable } from "../process/executable.js";
import type { StageContext, StageResult } from "../check/run-check.js";
import type { RawFinding } from "../domain/finding.js";
import { emptyMutation, type MutantResult, type MutationSummary } from "../domain/result.js";
import { addedLineRanges } from "../git/repository.js";
import { MutationError, type MutationAdapter, type MutationTarget } from "./adapter.js";
import { StrykerAdapter } from "./stryker.js";

export { MutationError };

/**
 * Targeted mutation testing (MI102, WARN by default).
 * Only added/modified lines of changed production files are mutated, within `mutation.maxMutants` and
 * `mutation.timeoutSeconds`. Any tool failure throws, which the pipeline turns into ERROR.
 */
export async function runMutationStage(ctx: StageContext, adapter: MutationAdapter = new StrykerAdapter()): Promise<StageResult<MutationSummary>> {
  const targets: MutationTarget[] = [];
  for (const change of ctx.deterministic.projectChanges) {
    if (change.fileClass !== "source" || change.status === "deleted") continue;
    const ranges = await addedLineRanges(ctx.repoRoot, ctx.mergeBase, ctx.head, change.path);
    if (ranges.length > 0) targets.push({ file: change.relPath, ranges });
  }
  if (targets.length === 0) {
    return { summary: emptyMutation("not-applicable", "no added or modified production lines"), findings: [] };
  }

  // A fresh worktree and sandbox: nothing written by earlier test runs is visible to mutation testing.
  const head = await ctx.workspace.freshWorktree("head", ctx.head);
  let result;
  try {
    const sandbox = await ctx.workspace.newSandbox();
    const env = untrustedEnv({ sandboxDir: sandbox.dir, passthrough: ctx.config.testEnvironment.passthrough });
    const node = resolveExecutable("node", env, ctx.workspace.untrustedRoots());
    if (!node) throw new MutationError("the project's Node.js executable was not found on PATH");
    result = await adapter.run({
      projectDir: head.projectDir,
      root: head.root,
      scratchDir: sandbox.scratch,
      framework: ctx.framework,
      targets,
      timeoutMs: ctx.config.mutation.timeoutSeconds * 1000,
      maxMutants: ctx.config.mutation.maxMutants,
      env,
      node,
    });
    await ctx.workspace.verifyDependencies();
  } finally {
    await ctx.workspace.disposeWorktree(head);
  }

  if (result.candidates === 0) {
    return { summary: emptyMutation("not-applicable", "no mutants can be generated for the changed lines"), findings: [] };
  }
  const count = (status: MutantResult["status"]) => result.mutants.filter((m) => m.status === status).length;
  const summary: MutationSummary = {
    status: "completed",
    candidates: result.candidates,
    attempted: result.mutants.length,
    killed: count("killed"),
    survived: count("survived"),
    noCoverage: count("no-coverage"),
    timedOut: count("timeout"),
    invalid: count("invalid"),
    sampled: result.sampled,
    survivors: result.mutants.filter((m) => m.status === "survived" || m.status === "no-coverage"),
  };
  if (summary.attempted > 0 && summary.attempted === summary.invalid) {
    throw new MutationError("every generated mutant was invalid (compile or runtime error); mutation testing produced no evidence");
  }

  const prefix = ctx.workingDirectory === "." ? "" : `${ctx.workingDirectory}/`;
  const byLine = new Map<string, MutantResult[]>();
  for (const survivor of summary.survivors) {
    const k = `${survivor.file}:${survivor.line}`;
    byLine.set(k, [...(byLine.get(k) ?? []), survivor]);
  }
  const findings: RawFinding[] = [...byLine.values()].map((group) => {
    const first = group[0] as MutantResult;
    const details = group
      .map((m) => `${m.mutator} → \`${m.replacement ?? ""}\`${m.status === "no-coverage" ? " (no test covers it)" : ""}`)
      .join("; ");
    return {
      ruleId: "MI102_MUTATION_SURVIVED",
      file: `${prefix}${first.file}`,
      startLine: first.line,
      message: `${group.length} mutant(s) on this changed line survived the tests: ${details}.`,
      evidence: { mutants: group },
    };
  });
  return { summary, findings };
}
