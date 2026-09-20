import type { Framework } from "../domain/config.js";
import type { MutantResult } from "../domain/result.js";

/** Changed lines (1-based, inclusive) of one production file, relative to the project directory. */
export interface MutationTarget {
  file: string;
  ranges: { start: number; end: number }[];
}

export interface MutationRunArgs {
  projectDir: string;
  /** Package resolution boundary (worktree root). */
  root: string;
  scratchDir: string;
  framework: Framework;
  targets: MutationTarget[];
  timeoutMs: number;
  maxMutants: number;
  /** Environment for untrusted processes (allowlisted, sandboxed). */
  env: NodeJS.ProcessEnv;
  /** Absolute path of the project's Node executable. */
  node: string;
}

export interface MutationRunResult {
  candidates: number;
  sampled: boolean;
  mutants: MutantResult[];
}

export class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationError";
  }
}

/**
 * Mutation-testing tool boundary. Implementations must throw MutationError for any failure
 * (startup, crash, timeout, inconsistent report) — a failure must never look like "all mutants killed".
 */
export interface MutationAdapter {
  run(args: MutationRunArgs): Promise<MutationRunResult>;
}
