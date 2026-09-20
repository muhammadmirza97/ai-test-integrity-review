import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Framework } from "../domain/config.js";
import { runProcess } from "../process/run.js";
import { parseRunnerJson, type ParsedRun } from "../red-green/classify-failure.js";
import { findInstalledPackage } from "./resolve.js";

export interface RunFilesArgs {
  /** Project directory in which the runner is started. */
  cwd: string;
  /** Resolution boundary for the runner package (the worktree root). */
  root: string;
  /** Absolute test file paths. */
  files: string[];
  timeoutMs: number;
  /** Private scratch directory for reports and caches (unique per execution). */
  scratchDir: string;
  /** Environment for the untrusted runner process (allowlisted, sandboxed). */
  env: NodeJS.ProcessEnv;
  /** Absolute path of the project's Node executable (resolved from PATH, not the host's execPath). */
  node: string;
}

export interface TestRunnerAdapter {
  framework: Framework;
  runFiles(args: RunFilesArgs): Promise<ParsedRun & { durationMs: number }>;
}

const MAX_REPORT_BYTES = 50 * 1024 * 1024;

async function readReport(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (info.size > MAX_REPORT_BYTES) return { malformed: "report too large" };
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { malformed: (error as Error).message };
  }
}

function adapter(framework: Framework): TestRunnerAdapter {
  return {
    framework,
    async runFiles({ cwd, root, files, timeoutMs, scratchDir, env: baseEnv, node }) {
      const started = Date.now();
      const binName = framework === "jest" ? "jest" : "vitest";
      const pkg = await findInstalledPackage(framework, cwd, root, binName);
      if (!pkg?.bin) {
        return {
          process: "crash",
          crashReason: `${framework} is not installed in the project (install dependencies before running Merge Integrity)`,
          files: new Map(),
          noTestsFound: false,
          durationMs: Date.now() - started,
        };
      }
      const id = randomUUID();
      const report = join(scratchDir, `${framework}-${id}.json`);
      const args =
        framework === "jest"
          ? [
              pkg.bin,
              "--ci",
              "--json",
              "--outputFile",
              report,
              "--coverage=false",
              "--watchman=false",
              "--runInBand",
              "--forceExit",
              "--colors=false",
              "--cacheDirectory",
              join(scratchDir, "jest-cache"),
              // Paths are matched exactly (not as regular expressions).
              "--runTestsByPath",
              ...files,
            ]
          : [
              pkg.bin,
              "run",
              ...files,
              "--reporter=json",
              `--outputFile=${report}`,
              "--coverage.enabled=false",
              "--watch=false",
              "--cache=false",
            ];
      const env = { ...baseEnv };
      env.NO_COLOR = "1";
      env.FORCE_COLOR = "0";
      const result = await runProcess({ command: node, args, cwd, env, timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
      const json = await readReport(report);
      await rm(report, { force: true });
      const parsed = parseRunnerJson(framework, {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        spawnError: result.spawnError,
        json,
        stderr: result.stderr.slice(-20_000),
      });
      return { ...parsed, durationMs: Date.now() - started };
    },
  };
}

export function testRunnerFor(framework: Framework): TestRunnerAdapter {
  return adapter(framework);
}
