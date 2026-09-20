import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
import { untrustedEnv } from "./env.js";


export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
  spawnError?: string;
}

const DEFAULT_MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Run a process without a shell, with a hard timeout that kills the whole process tree.
 * Never throws for process failures; callers must classify the result.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  if (!(options.timeoutMs > 0)) {
    return Promise.reject(new Error("runProcess: timeoutMs must be positive"));
  }
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise((resolvePromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? untrustedEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunks: Buffer[], chunk: Buffer, which: "out" | "err") => {
      const used = which === "out" ? stdoutBytes : stderrBytes;
      const room = maxOutput - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      chunks.push(piece);
      if (which === "out") stdoutBytes += piece.length;
      else stderrBytes += piece.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, "err"));

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // On POSIX, always reap the process group so background children cannot outlive the stage.
      // On Windows the tree can only be walked while the parent lives (and PIDs are reused quickly),
      // so post-exit reaping is not attempted there; see docs/THREAT_MODEL limitations.
      const reap = process.platform === "win32" && !timedOut ? Promise.resolve() : killTree(child.pid);
      void reap.finally(() => {
        resolvePromise({
          exitCode,
          signal,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          outputTruncated: truncated,
          durationMs: Date.now() - started,
          ...(spawnError === undefined ? {} : { spawnError }),
        });
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid).then(() => {
        // If the process ignores the kill (e.g. stuck in uninterruptible IO) do not wait forever.
        setTimeout(() => finish(null, "SIGKILL"), 5_000).unref();
      });
    }, options.timeoutMs);

    child.on("error", (error) => finish(null, null, error.message));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** Kill a process and all of its descendants. Safe to call for already-exited processes. */
export function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolvePromise) => {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? join("C:", "Windows");
      const taskkill = join(systemRoot, "System32", "taskkill.exe");
      execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, () =>
        resolvePromise(),
      );
    });
  }
  try {
    // Negative PID targets the process group created by `detached: true`.
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group already gone.
  }
  return Promise.resolve();
}
