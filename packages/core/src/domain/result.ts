import type { Finding, IgnoredFinding } from "./finding.js";

export type OverallStatus = "pass" | "warn" | "block" | "error";

/**
 * Stage outcome. Only `completed`, `disabled` and `not-applicable` are trustworthy for a PASS.
 * `skipped` means the stage did not run because a blocking finding already decided the result.
 */
export type StageStatus = "completed" | "disabled" | "not-applicable" | "skipped" | "error";

export const TRUSTWORTHY_STAGE_STATUSES: readonly StageStatus[] = ["completed", "disabled", "not-applicable"];

export interface AnalysisError {
  code: string;
  message: string;
  stage: string;
}

export type RedGreenOutcome = "verified" | "non-discriminating" | "inconclusive" | "not-applicable";

export interface RedGreenTestResult {
  /** Suite path and test name. */
  name: string[];
  line: number;
  outcome: RedGreenOutcome;
  reason: string;
  head?: string;
  baseOverlay?: string;
  confirmation?: string;
}

export interface RedGreenFileResult {
  file: string;
  /** Aggregate: non-discriminating if any changed test is; verified only if every changed test is verified. */
  outcome: RedGreenOutcome;
  reason: string;
  head?: string;
  baseOriginal?: string;
  baseOverlay?: string;
  tests: RedGreenTestResult[];
}

export interface RedGreenSummary {
  status: StageStatus;
  reason?: string;
  verifiedFiles: number;
  nonDiscriminatingFiles: number;
  inconclusiveFiles: number;
  verifiedTests: number;
  nonDiscriminatingTests: number;
  inconclusiveTests: number;
  files: RedGreenFileResult[];
}

export interface MutantResult {
  file: string;
  line: number;
  column: number;
  mutator: string;
  replacement?: string;
  status: "killed" | "survived" | "no-coverage" | "timeout" | "invalid" | "ignored";
}

export interface MutationSummary {
  status: StageStatus;
  reason?: string;
  /** Mutants inside changed production lines that were eligible before the budget was applied. */
  candidates: number;
  attempted: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timedOut: number;
  invalid: number;
  /** True when the max-mutant budget selected a deterministic subset of candidates. */
  sampled: boolean;
  survivors: MutantResult[];
}

export interface StageTimings {
  [stage: string]: number;
}

export interface AnalysisReport {
  schemaVersion: 1;
  status: OverallStatus;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha?: string;
  framework?: "jest" | "vitest";
  configSource?: "base" | "head" | "file" | "default";
  findings: Finding[];
  ignoredFindings: IgnoredFinding[];
  redGreen: RedGreenSummary;
  mutation: MutationSummary;
  durationMs: number;
  timings: StageTimings;
  error?: AnalysisError;
  notes: string[];
}

export function emptyRedGreen(status: StageStatus, reason?: string): RedGreenSummary {
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    verifiedFiles: 0,
    nonDiscriminatingFiles: 0,
    inconclusiveFiles: 0,
    verifiedTests: 0,
    nonDiscriminatingTests: 0,
    inconclusiveTests: 0,
    files: [],
  };
}

export function emptyMutation(status: StageStatus, reason?: string): MutationSummary {
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    candidates: 0,
    attempted: 0,
    killed: 0,
    survived: 0,
    noCoverage: 0,
    timedOut: 0,
    invalid: 0,
    sampled: false,
    survivors: [],
  };
}
