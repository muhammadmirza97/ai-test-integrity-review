import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exitCodeFor, renderJson, renderText, runCheck, type VerificationStages } from "@merge-integrity/core";
import type { CliIo } from "./cli.js";

export interface CheckCommandOptions {
  cwd: string;
  baseRef: string | undefined;
  headRef: string;
  workingDirectory: string | undefined;
  framework: "auto" | "jest" | "vitest" | undefined;
  configPath: string | undefined;
  configSource: "base" | "head";
  format: "text" | "json";
  output: string | undefined;
  mutation: boolean | undefined;
  redGreen: false | undefined;
}

export async function runCheckCommand(options: CheckCommandOptions, io: CliIo, stages?: VerificationStages): Promise<number> {
  const { report, config } = await runCheck(
    {
      cwd: options.cwd,
      baseRef: options.baseRef,
      headRef: options.headRef,
      workingDirectory: options.workingDirectory,
      framework: options.framework,
      configPath: options.configPath,
      configSource: options.configSource,
      redGreen: options.redGreen,
      mutation: options.mutation,
    },
    stages,
  );

  let exitCode = exitCodeFor(report.status, config.policy);
  if (options.output !== undefined) {
    try {
      const target = resolve(options.cwd, options.output);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, renderJson(report));
    } catch (error) {
      io.stderr(`Could not write report to ${options.output}: ${(error as Error).message}\n`);
      exitCode = 2;
    }
  }
  io.stdout(options.format === "json" ? renderJson(report) : renderText(report));
  return exitCode;
}
