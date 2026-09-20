import { resolve } from "node:path";
import type { StageContext, StageResult } from "../check/run-check.js";
import type { Framework } from "../domain/config.js";
import type { RawFinding } from "../domain/finding.js";
import type { RedGreenFileResult, RedGreenSummary, RedGreenTestResult } from "../domain/result.js";
import { testRunnerFor, type TestRunnerAdapter } from "../framework/test-runner.js";
import { untrustedEnv } from "../process/env.js";
import { resolveExecutable } from "../process/executable.js";
import type { ChangedTest } from "../rules/test-integrity.js";
import { classifyFile, classifyTestCase, type FileClassification, type ParsedRun } from "./classify-failure.js";
import type { Workspace, Worktree } from "./worktree.js";

export class RedGreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedGreenError";
  }
}

export interface RedGreenOptions {
  workspace: Workspace;
  runnerFor?: (framework: Framework) => TestRunnerAdapter;
}

interface Target {
  headPath: string;
  basePath?: string;
  tests: ChangedTest[];
}

const describeKind = (c: { kind: string; detail: string }) => `${c.kind} (${c.detail})`;
const displayName = (namePath: string[]) => namePath.map((n) => JSON.stringify(n)).join(" > ");

/**
 * Red/green verification (MI006 and MI103, both advisory WARN by default), per changed test case.
 *
 * Every execution uses a fresh worktree and a fresh sandbox (HOME, TMP, caches), so no run can observe state left
 * by another. Installed dependencies are verified unchanged after each run.
 *
 * 1. Head: every changed test file must pass; each changed test must be reported as passed under its static name.
 * 2. Base original (files that existed at the merge base): must pass, otherwise the file's tests are inconclusive.
 * 3. Base overlay: head test files (plus changed test-support files and snapshots) on the base implementation.
 *    Each changed test is classified on its own:
 *      assertion failure (confirmed by a second fresh run) -> verified
 *      passed                                              -> MI006 (MI103 if dependency manifests changed)
 *      anything else (errors, skipped, not found)          -> MI103
 *    Timeouts and crashes are ERROR. One RED test never verifies another test.
 */
export async function verifyRedGreen(ctx: StageContext, options: RedGreenOptions): Promise<StageResult<RedGreenSummary>> {
  const { deterministic, config, workspace } = ctx;
  const runner = (options.runnerFor ?? testRunnerFor)(ctx.framework);
  const deadline = Date.now() + config.redGreen.timeoutSeconds * 1000;
  const remaining = () => deadline - Date.now();

  const changeByPath = new Map(deterministic.projectChanges.map((c) => [c.path, c]));
  const targets: Target[] = deterministic.changedTestFiles.map((headPath) => {
    const change = changeByPath.get(headPath);
    const basePath = change?.status === "added" || change?.status === "copied" ? undefined : (change?.oldPath ?? headPath);
    return { headPath, ...(basePath ? { basePath } : {}), tests: deterministic.changedTests.get(headPath) ?? [] };
  });

  const overlayPaths = new Set<string>(targets.map((t) => t.headPath));
  for (const change of deterministic.projectChanges) {
    if (change.status === "deleted") continue;
    if (change.fileClass === "test-support" || change.fileClass === "snapshot" || change.fileClass === "test") overlayPaths.add(change.path);
  }

  /** One isolated execution: fresh worktree, optional overlay, fresh sandbox, dependency verification, disposal. */
  const execute = async (label: "base" | "head", commit: string, files: string[], overlay: boolean): Promise<{ run: ParsedRun; wt: Worktree }> => {
    if (remaining() <= 0) throw new RedGreenError("red/green verification exceeded its time budget");
    const wt = await workspace.freshWorktree(label, commit);
    try {
      if (overlay) for (const path of [...overlayPaths].sort()) await workspace.overlayFromCommit(wt, ctx.head, path);
      const sandbox = await workspace.newSandbox();
      const env = untrustedEnv({ sandboxDir: sandbox.dir, passthrough: config.testEnvironment.passthrough });
      const node = resolveExecutable("node", env, workspace.untrustedRoots());
      if (!node) throw new RedGreenError("the project's Node.js executable was not found on PATH");
      const run = await runner.runFiles({
        cwd: wt.projectDir,
        root: wt.root,
        files: files.map((p) => resolve(wt.root, ...p.split("/"))),
        timeoutMs: remaining(),
        scratchDir: sandbox.scratch,
        env,
        node,
      });
      await workspace.verifyDependencies();
      return { run, wt };
    } finally {
      await workspace.disposeWorktree(wt);
    }
  };
  const fileClass = (wt: Worktree, run: ParsedRun, path: string): FileClassification => classifyFile(run, resolve(wt.root, ...path.split("/")));
  const testClass = (wt: Worktree, run: ParsedRun, path: string, test: ChangedTest) =>
    classifyTestCase(run, resolve(wt.root, ...path.split("/")), test.namePath);

  const results = new Map<string, RedGreenFileResult>();
  const setInconclusiveFile = (target: Target, reason: string, extra: Partial<RedGreenFileResult> = {}) => {
    results.set(target.headPath, {
      file: target.headPath,
      outcome: "inconclusive",
      reason,
      ...extra,
      tests: target.tests.map((t) => ({ name: t.namePath, line: t.line, outcome: "inconclusive", reason })),
    });
  };

  // 1. Head.
  const head = await execute("head", ctx.head, targets.map((t) => t.headPath), false);
  const eligible = new Map<Target, ChangedTest[]>();
  for (const target of targets) {
    const c = fileClass(head.wt, head.run, target.headPath);
    if (c.kind === "timeout") throw new RedGreenError(`red/green verification timed out running ${target.headPath} on the PR head`);
    if (c.kind === "not-collected" || c.kind === "no-tests") {
      setInconclusiveFile(target, `on the PR head: ${c.detail}`, { head: c.kind });
      continue;
    }
    if (c.kind !== "passed") throw new RedGreenError(`changed test file ${target.headPath} does not pass on the PR head: ${describeKind(c)}`);
    const verifiable: ChangedTest[] = [];
    const early: RedGreenTestResult[] = [];
    for (const test of target.tests) {
      if (test.dynamicName) {
        early.push({ name: test.namePath, line: test.line, outcome: "inconclusive", reason: "the test name is generated at runtime and cannot be matched to results", head: "not-matched" });
        continue;
      }
      const t = testClass(head.wt, head.run, target.headPath, test);
      if (t.kind === "passed") verifiable.push(test);
      else early.push({ name: test.namePath, line: test.line, outcome: "inconclusive", reason: `on the PR head: ${t.detail}`, head: t.kind });
    }
    results.set(target.headPath, { file: target.headPath, outcome: "inconclusive", reason: "", head: "passed", tests: early });
    if (verifiable.length > 0) eligible.set(target, verifiable);
  }

  // 2. Original base versions.
  const withBase = [...eligible.keys()].filter((t) => t.basePath !== undefined);
  if (withBase.length > 0) {
    const original = await execute("base", ctx.mergeBase, withBase.map((t) => t.basePath as string), false);
    for (const target of withBase) {
      const c = fileClass(original.wt, original.run, target.basePath as string);
      if (c.kind === "timeout" || c.kind === "crash") {
        throw new RedGreenError(`red/green verification could not run the original ${target.basePath} on the base: ${describeKind(c)}`);
      }
      const entry = results.get(target.headPath) as RedGreenFileResult;
      entry.baseOriginal = c.kind;
      if (c.kind !== "passed" && c.kind !== "no-tests") {
        const reason = `the original test file already fails on the base: ${c.detail}`;
        for (const test of eligible.get(target) ?? []) entry.tests.push({ name: test.namePath, line: test.line, outcome: "inconclusive", reason, head: "passed" });
        eligible.delete(target);
      }
    }
  }

  // 3. Overlay onto the base, then confirm RED in another fresh worktree.
  if (eligible.size > 0) {
    const files = [...eligible.keys()].map((t) => t.headPath);
    const overlay = await execute("base", ctx.mergeBase, files, true);
    const red = new Map<Target, ChangedTest[]>();
    for (const [target, tests] of eligible) {
      const entry = results.get(target.headPath) as RedGreenFileResult;
      entry.baseOverlay = fileClass(overlay.wt, overlay.run, target.headPath).kind;
      for (const test of tests) {
        const t = testClass(overlay.wt, overlay.run, target.headPath, test);
        const base = { name: test.namePath, line: test.line, head: "passed", baseOverlay: t.kind };
        if (t.kind === "timeout" || t.kind === "crash") {
          throw new RedGreenError(`red/green verification could not run ${target.headPath} against the base: ${describeKind(t)}`);
        }
        if (t.kind === "assertion-failure") {
          red.set(target, [...(red.get(target) ?? []), test]);
          entry.tests.push({ ...base, outcome: "verified", reason: t.detail });
        } else if (t.kind === "passed") {
          entry.tests.push({
            ...base,
            outcome: deterministic.dependencyManifestChanged ? "inconclusive" : "non-discriminating",
            reason: deterministic.dependencyManifestChanged
              ? "the test also passes against the base code, but dependency manifests changed and cannot be reproduced on the base"
              : "the test also passes against the base implementation",
          });
        } else {
          entry.tests.push({ ...base, outcome: "inconclusive", reason: `against the base: ${t.detail}` });
        }
      }
    }

    if (red.size > 0) {
      const confirm = await execute("base", ctx.mergeBase, [...red.keys()].map((t) => t.headPath), true);
      for (const [target, tests] of red) {
        const entry = results.get(target.headPath) as RedGreenFileResult;
        for (const test of tests) {
          const t = testClass(confirm.wt, confirm.run, target.headPath, test);
          if (t.kind === "timeout" || t.kind === "crash") {
            throw new RedGreenError(`red/green confirmation run failed for ${target.headPath}: ${describeKind(t)}`);
          }
          const record = entry.tests.find((r) => JSON.stringify(r.name) === JSON.stringify(test.namePath) && r.outcome === "verified");
          if (!record) continue;
          record.confirmation = t.kind;
          if (t.kind !== "assertion-failure") {
            record.outcome = "inconclusive";
            record.reason = `the base failure was not reproducible (first run: assertion failure; second run: ${t.kind})`;
          }
        }
      }
    }
  }

  // Aggregate per file.
  const files = targets.map((t) => {
    const entry = results.get(t.headPath) as RedGreenFileResult;
    const tests = entry.tests;
    if (tests.some((x) => x.outcome === "non-discriminating")) {
      entry.outcome = "non-discriminating";
      entry.reason = "at least one changed test passes against the base implementation";
    } else if (tests.length > 0 && tests.every((x) => x.outcome === "verified")) {
      entry.outcome = "verified";
      entry.reason = "every changed test fails on the base with an assertion and passes on the PR head";
    } else if (entry.reason === "") {
      entry.outcome = "inconclusive";
      entry.reason = "not every changed test could be verified";
    }
    return entry;
  });

  const findings: RawFinding[] = [];
  for (const file of files) {
    for (const test of file.tests.filter((x) => x.outcome === "non-discriminating")) {
      findings.push({
        ruleId: "MI006_REGRESSION_TEST_NON_DISCRIMINATING",
        file: file.file,
        startLine: test.line,
        message: `The changed test ${displayName(test.name)} passes against both the base and the PR implementation. It does not prove this PR changed the behaviour it tests.`,
        evidence: { test: test.name, head: test.head, baseOverlay: test.baseOverlay },
      });
    }
    const inconclusive = file.tests.filter((x) => x.outcome === "inconclusive");
    if (inconclusive.length > 0) {
      findings.push({
        ruleId: "MI103_RED_GREEN_INCONCLUSIVE",
        file: file.file,
        ...(inconclusive[0] ? { startLine: inconclusive[0].line } : {}),
        message: `Red/green verification was inconclusive for ${inconclusive.length} changed test(s): ${inconclusive
          .slice(0, 5)
          .map((x) => `${displayName(x.name)} (${x.reason})`)
          .join("; ")}.`,
        evidence: { tests: inconclusive.map((x) => ({ name: x.name, reason: x.reason })) },
      });
    }
  }

  const allTests = files.flatMap((f) => f.tests);
  return {
    summary: {
      status: "completed",
      verifiedFiles: files.filter((f) => f.outcome === "verified").length,
      nonDiscriminatingFiles: files.filter((f) => f.outcome === "non-discriminating").length,
      inconclusiveFiles: files.filter((f) => f.outcome === "inconclusive").length,
      verifiedTests: allTests.filter((t) => t.outcome === "verified").length,
      nonDiscriminatingTests: allTests.filter((t) => t.outcome === "non-discriminating").length,
      inconclusiveTests: allTests.filter((t) => t.outcome === "inconclusive").length,
      files,
    },
    findings,
  };
}
