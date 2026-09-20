import { renderDoctorJson, renderDoctorText, runDoctor, type DoctorOptions } from "@merge-integrity/core";
import type { CliIo } from "./cli.js";

export interface DoctorCommandOptions extends DoctorOptions {
  format?: "text" | "json";
}

/**
 * Preflight. Exit code 0 when the repository is SUPPORTED or SUPPORTED WITH WARNINGS, 2 when it is UNSUPPORTED
 * as configured or the preflight itself could not run.
 */
export async function runDoctorCommand(options: DoctorCommandOptions, io: CliIo): Promise<number> {
  const { format = "text", ...doctorOptions } = options;
  let report;
  try {
    report = await runDoctor(doctorOptions);
  } catch (error) {
    io.stderr(`Merge Integrity preflight: ERROR\n${(error as Error).message}\n`);
    return 2;
  }
  io.stdout(format === "json" ? renderDoctorJson(report) : renderDoctorText(report));
  return report.ok ? 0 : 2;
}
