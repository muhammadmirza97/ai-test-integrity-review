import { trustedToolEnv } from "../process/env.js";
import { resolveExecutable } from "../process/executable.js";
import { runProcess, type RunResult } from "../process/run.js";

export class GitError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const GIT_TIMEOUT_MS = 120_000;

/**
 * Hardened Git invocation: argument array only, no pager, no prompts, no external diff or textconv helpers.
 * Callers must place untrusted paths after `--` and refs after `--end-of-options`.
 */
export async function git(
  args: readonly string[],
  cwd: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<RunResult> {
  // Resolve Git to an absolute path so a `git` binary committed to the repository can never be picked up.
  const executable = resolveExecutable("git", process.env, [cwd]);
  if (!executable) {
    return { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", outputTruncated: false, durationMs: 0, spawnError: "git was not found on PATH" };
  }
  const env = trustedToolEnv();
  env.CI = "true";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  // Paths are data: never interpret `:(magic)` pathspec syntax from repository file names.
  env.GIT_LITERAL_PATHSPECS = "1";
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_EXTERNAL_DIFF;
  return runProcess({
    command: executable,
    args: ["-c", "core.quotepath=false", "-c", "diff.external=", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args],
    cwd,
    env,
    timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
  });
}

/** Run Git and throw GitError unless it exits 0. */
export async function gitOk(args: readonly string[], cwd: string, options?: { timeoutMs?: number; maxOutputBytes?: number }) {
  const result = await git(args, cwd, options);
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? "timed out" : result.spawnError ?? result.stderr.trim().split("\n").slice(0, 3).join(" ");
    throw new GitError(`git ${args[0] ?? ""} failed: ${detail}`, result);
  }
  if (result.outputTruncated) throw new GitError(`git ${args[0] ?? ""} output exceeded the size limit`, result);
  return result;
}
