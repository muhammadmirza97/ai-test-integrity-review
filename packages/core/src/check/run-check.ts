import { isParsableSource, SourceParseError } from "../ast/parse.js";
import { discoverTestFiles } from "../framework/discovery.js";
import { loadConfigFromCommit, type CommitConfig } from "../config/load.js";
import { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH } from "../config/parse.js";
import type { Framework, FrameworkSetting, MergeIntegrityConfig } from "../domain/config.js";
import type { Finding, RawFinding } from "../domain/finding.js";
import {
  emptyMutation,
  emptyRedGreen,
  type AnalysisError,
  type AnalysisReport,
  type MutationSummary,
  type RedGreenSummary,
} from "../domain/result.js";
import { detectFramework, type ProjectFileReader } from "../framework/detect.js";
import { isSafeRelativePath, normalizeRelativePath } from "../fs/paths.js";
import { GitError } from "../git/git.js";
import {
  BlobTooLargeError,
  findRepositoryRoot,
  isShallowRepository,
  listChangedFiles,
  listTreeNames,
  readBlob,
  resolveCommit,
  treeEntry,
  uniqueMergeBase,
} from "../git/repository.js";
import { applyIgnorePolicy, evaluateStatus } from "../policy/evaluate.js";
import { comparePolicies } from "../rules/policy-weakened.js";
import { AnalysisInputError, runDeterministicRules, toFindings, type DeterministicResult } from "../rules/registry.js";
import { RedGreenError, verifyRedGreen } from "../red-green/verifier.js";
import { DependencyTamperError, Workspace } from "../red-green/worktree.js";
import { MutationError, runMutationStage } from "../mutation/stage.js";

export interface CheckOptions {
  cwd: string;
  baseRef: string | undefined;
  headRef: string;
  workingDirectory?: string | undefined;
  framework?: FrameworkSetting | undefined;
  configPath?: string | undefined;
  configSource: "base" | "head";
  /** `false` disables red/green for this run (recorded in report notes). */
  redGreen?: false | undefined;
  /** `true` enables or `false` disables mutation testing for this run, overriding the policy (recorded in notes). */
  mutation?: boolean | undefined;
}

export interface StageContext {
  repoRoot: string;
  mergeBase: string;
  head: string;
  workingDirectory: string;
  framework: Framework;
  config: MergeIntegrityConfig;
  deterministic: DeterministicResult;
  workspace: Workspace;
}

export interface StageResult<S> {
  summary: S;
  findings: RawFinding[];
}

export interface VerificationStages {
  redGreen?: (ctx: StageContext) => Promise<StageResult<RedGreenSummary>>;
  mutation?: (ctx: StageContext, redGreen: RedGreenSummary) => Promise<StageResult<MutationSummary>>;
}

export interface CheckOutcome {
  report: AnalysisReport;
  config: MergeIntegrityConfig;
}

class CheckError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
  ) {
    super(message);
  }
}

function gitReader(repoRoot: string, commit: string, workingDirectory: string): ProjectFileReader {
  let names: Promise<Set<string>> | undefined;
  const prefix = workingDirectory === "." ? "" : `${workingDirectory}/`;
  return {
    async exists(path) {
      names ??= listTreeNames(repoRoot, commit, workingDirectory).then((list) => new Set(list));
      return (await names).has(path);
    },
    async readText(path) {
      try {
        const blob = await readBlob(repoRoot, commit, `${prefix}${path}`, 2 * 1024 * 1024);
        return blob.kind === "file" ? blob.text : undefined;
      } catch (error) {
        if (error instanceof BlobTooLargeError) return undefined;
        throw error;
      }
    },
  };
}

/**
 * Run a full Merge Integrity check. Never throws: every failure becomes an ERROR report.
 * The only way to obtain PASS is for every required stage to complete without findings.
 */
export function defaultStages(): VerificationStages {
  return {
    redGreen: (ctx) => verifyRedGreen(ctx, { workspace: ctx.workspace }),
    mutation: (ctx) => runMutationStage(ctx),
  };
}

export async function runCheck(options: CheckOptions, stages: VerificationStages = defaultStages()): Promise<CheckOutcome> {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const notes: string[] = [];
  let config: MergeIntegrityConfig = DEFAULT_CONFIG;
  let findings: Finding[] = [];
  let ignoredFindings: AnalysisReport["ignoredFindings"] = [];
  let redGreen: RedGreenSummary = emptyRedGreen("error", "not started");
  let mutation: MutationSummary = emptyMutation("error", "not started");
  let error: AnalysisError | undefined;
  const partial: Partial<AnalysisReport> = {};

  const timed = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings[stage] = (timings[stage] ?? 0) + (Date.now() - t0);
    }
  };

  try {
    const { repoRoot, baseSha, headSha, mergeBase } = await timed("git", async () => {
      let repoRoot: string;
      try {
        repoRoot = await findRepositoryRoot(options.cwd);
      } catch {
        throw new CheckError("NOT_A_REPOSITORY", "git", "the working directory is not inside a Git repository");
      }
      if (await isShallowRepository(repoRoot)) {
        throw new CheckError(
          "SHALLOW_CLONE",
          "git",
          "base revision history is unavailable: the repository is a shallow clone (use actions/checkout with fetch-depth: 0)",
        );
      }
      if (options.baseRef === undefined || options.baseRef === "") {
        throw new CheckError("BASE_REF_REQUIRED", "git", "a base revision is required (--base)");
      }
      const baseSha = await resolveCommit(repoRoot, options.baseRef);
      if (!baseSha) {
        throw new CheckError("BASE_UNAVAILABLE", "git", `base revision ${JSON.stringify(options.baseRef)} is unavailable in the local history`);
      }
      const headSha = await resolveCommit(repoRoot, options.headRef);
      if (!headSha) {
        throw new CheckError("HEAD_UNAVAILABLE", "git", `head revision ${JSON.stringify(options.headRef)} is unavailable in the local history`);
      }
      let mergeBase: string;
      try {
        mergeBase = await uniqueMergeBase(repoRoot, baseSha, headSha);
      } catch (e) {
        throw new CheckError("MERGE_BASE_UNAVAILABLE", "git", (e as Error).message);
      }
      return { repoRoot, baseSha, headSha, mergeBase };
    });
    Object.assign(partial, { baseRef: options.baseRef, headRef: options.headRef, baseSha, headSha });

    const policyFindings: RawFinding[] = [];
    config = await timed("config", async () => {
      const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
      if (!isSafeRelativePath(configPath)) {
        throw new CheckError("CONFIG_PATH_INVALID", "config", "the config path must be relative to the repository root");
      }
      const normalizedConfigPath = normalizeRelativePath(configPath);
      const fromBase = await loadConfigFromCommit(repoRoot, baseSha, normalizedConfigPath, "base");
      const fromHead = await loadConfigFromCommit(repoRoot, headSha, normalizedConfigPath, "head");
      const chosen: CommitConfig = options.configSource === "base" ? fromBase : fromHead;
      if (chosen.kind === "invalid") {
        throw new CheckError("CONFIG_INVALID", "config", `invalid ${options.configSource} configuration: ${chosen.errors.join("; ")}`);
      }
      partial.configSource = chosen.kind === "missing" ? "default" : options.configSource;
      const effective = chosen.kind === "valid" ? chosen.config : DEFAULT_CONFIG;
      const baseEffective = fromBase.kind === "valid" ? fromBase.config : DEFAULT_CONFIG;
      const headEffective = fromHead.kind === "valid" ? fromHead.config : fromHead.kind === "missing" ? DEFAULT_CONFIG : "invalid";
      if (fromBase.kind !== "invalid") {
        policyFindings.push(...comparePolicies(normalizedConfigPath, baseEffective, headEffective, options.configSource));
      }
      return effective;
    });

    const workingDirectory = normalizeRelativePath(options.workingDirectory ?? config.workingDirectory);
    if (!isSafeRelativePath(workingDirectory, { allowDot: true })) {
      throw new CheckError("WORKING_DIRECTORY_INVALID", "config", "the working directory must be a relative path inside the repository");
    }
    if (workingDirectory !== ".") {
      const entry = await treeEntry(repoRoot, headSha, workingDirectory);
      if (!entry || entry.type !== "tree") {
        throw new CheckError("WORKING_DIRECTORY_MISSING", "config", `working directory ${JSON.stringify(workingDirectory)} does not exist in the head revision`);
      }
    }
    const redGreenEnabled = config.redGreen.enabled && options.redGreen !== false;
    const mutationEnabled = options.mutation ?? config.mutation.enabled;
    if (config.redGreen.enabled && options.redGreen === false) notes.push("red/green verification disabled by command-line option");
    if (config.mutation.enabled && options.mutation === false) notes.push("mutation testing disabled by command-line option");
    if (!config.mutation.enabled && options.mutation === true) notes.push("mutation testing enabled by command-line option");

    const detection = await timed("framework", () =>
      detectFramework(gitReader(repoRoot, headSha, workingDirectory), options.framework ?? config.framework),
    );
    if (detection.kind !== "jest" && detection.kind !== "vitest") {
      throw new CheckError("UNSUPPORTED_PROJECT", "framework", `${detection.kind}: ${"reason" in detection ? detection.reason : "unsupported"}`);
    }
    partial.framework = detection.kind;

    // Discovery settings come from the merge base: a pull request must not be able to reclassify production files as
    // tests (which would skip red/green and mutation). Changes to discovery settings are reported by MI105.
    const discovery = await timed("framework", () => discoverTestFiles(gitReader(repoRoot, mergeBase, workingDirectory), detection.kind));
    const deterministic = await timed("deterministic", async () => {
      const changes = await listChangedFiles(repoRoot, mergeBase, headSha);
      const result = await runDeterministicRules({ repoRoot, mergeBase, head: headSha, workingDirectory, changes, isTestFile: discovery.isTestFile });
      if (discovery.kind === "unsupported") {
        const unclassifiedCode = result.projectChanges.some((c) => c.fileClass !== "test" && isParsableSource(c.relPath));
        if (unclassifiedCode) {
          const prefix = workingDirectory === "." ? "" : `${workingDirectory}/`;
          result.rawFindings.push({
            ruleId: "MI107_TEST_DISCOVERY_UNSUPPORTED",
            file: `${prefix}${discovery.source ?? "package.json"}`,
            message: `Custom test discovery could not be analysed (${discovery.reason}). Only files matching standard test naming were checked as tests; changed JavaScript/TypeScript files may contain tests that were not analysed.`,
          });
        }
      }
      return result;
    });

    const applyPolicy = (raw: RawFinding[]) => {
      const ignored = applyIgnorePolicy(toFindings(raw, config), config.ignore);
      findings = ignored.findings;
      ignoredFindings = ignored.ignoredFindings;
    };
    const allRaw: RawFinding[] = [...policyFindings, ...deterministic.rawFindings];
    applyPolicy(allRaw);
    const blocked = findings.some((f) => f.severity === "block");

    const workspace = new Workspace(repoRoot, workingDirectory);
    const ctx: StageContext = {
      repoRoot,
      mergeBase,
      head: headSha,
      workingDirectory,
      framework: detection.kind,
      config,
      deterministic,
      workspace,
    };
    try {
      await runStages();
    } finally {
      try {
        await timed("cleanup", () => workspace.cleanup());
      } catch (cleanupError) {
        error ??= { code: "CLEANUP_FAILED", stage: "cleanup", message: (cleanupError as Error).message };
      }
    }

    async function runStages(): Promise<void> {
    if (!redGreenEnabled) {
      redGreen = emptyRedGreen("disabled");
    } else if (blocked) {
      redGreen = emptyRedGreen("skipped", "blocking findings already decide the result");
    } else if (deterministic.changedTestFiles.length === 0) {
      redGreen = emptyRedGreen("not-applicable", "no changed or added tests");
    } else if (!deterministic.implementationChanged) {
      redGreen = emptyRedGreen("not-applicable", "no implementation change to verify against");
    } else if (!stages.redGreen) {
      redGreen = emptyRedGreen("error", "red/green verification is not available in this build");
    } else {
      try {
        const result = await timed("redGreen", () => (stages.redGreen as NonNullable<VerificationStages["redGreen"]>)(ctx));
        redGreen = result.summary;
        allRaw.push(...result.findings);
        applyPolicy(allRaw);
      } catch (stageError) {
        redGreen = emptyRedGreen("error", (stageError as Error).message);
        throw stageError;
      }
    }

    const blockedNow = findings.some((f) => f.severity === "block");
    const sourceChanged = deterministic.projectChanges.some((c) => c.fileClass === "source" && c.status !== "deleted");
    if (!mutationEnabled) {
      mutation = emptyMutation("disabled");
    } else if (blockedNow) {
      mutation = emptyMutation("skipped", "blocking findings already decide the result");
    } else if (redGreen.status === "error") {
      mutation = emptyMutation("skipped", "red/green verification failed");
    } else if (!sourceChanged) {
      mutation = emptyMutation("not-applicable", "no changed production source files");
    } else if (!stages.mutation) {
      mutation = emptyMutation("error", "mutation testing is not available in this build");
    } else {
      try {
        const result = await timed("mutation", () => (stages.mutation as NonNullable<VerificationStages["mutation"]>)(ctx, redGreen));
        mutation = result.summary;
        allRaw.push(...result.findings);
        applyPolicy(allRaw);
      } catch (stageError) {
        mutation = emptyMutation("error", (stageError as Error).message);
        throw stageError;
      }
    }
    }
  } catch (caught) {
    error = toAnalysisError(caught);
  }

  const stageStatuses = [redGreen.status, mutation.status];
  const status = evaluateStatus({ findings, error, stages: stageStatuses });
  if (status === "error" && !error) {
    const failed = redGreen.status === "error" ? redGreen : mutation;
    error = { code: "STAGE_FAILED", stage: redGreen.status === "error" ? "redGreen" : "mutation", message: failed.reason ?? "verification stage failed" };
  }
  if (error && redGreen.status === "error" && redGreen.reason === "not started") redGreen = emptyRedGreen("skipped", "analysis stopped");
  if (error && mutation.status === "error" && mutation.reason === "not started") mutation = emptyMutation("skipped", "analysis stopped");

  return {
    config,
    report: {
      schemaVersion: 1,
      status,
      ...partial,
      findings,
      ignoredFindings,
      redGreen,
      mutation,
      durationMs: Date.now() - started,
      timings,
      notes,
      ...(error ? { error } : {}),
    },
  };
}

function toAnalysisError(caught: unknown): AnalysisError {
  if (caught instanceof CheckError) return { code: caught.code, stage: caught.stage, message: caught.message };
  if (caught instanceof SourceParseError) return { code: "PARSE_FAILED", stage: "deterministic", message: caught.message };
  if (caught instanceof AnalysisInputError) return { code: caught.code, stage: "deterministic", message: caught.message };
  if (caught instanceof DependencyTamperError) return { code: "DEPENDENCIES_MODIFIED", stage: "isolation", message: caught.message };
  if (caught instanceof RedGreenError) return { code: "RED_GREEN_FAILED", stage: "redGreen", message: caught.message };
  if (caught instanceof MutationError) return { code: "MUTATION_FAILED", stage: "mutation", message: caught.message };
  if (caught instanceof GitError) return { code: "GIT_FAILED", stage: "git", message: caught.message };
  return { code: "INTERNAL_ERROR", stage: "check", message: `unexpected failure: ${(caught as Error)?.message ?? String(caught)}` };
}
