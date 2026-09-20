import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyMutation,
  emptyRedGreen,
  exitCodeFor,
  renderDoctorSummary,
  renderDoctorText,
  renderJson,
  renderText,
  runCheck,
  runDoctor,
  terminalText,
  VERDICT_LABEL,
  DEFAULT_CONFIG,
  type AnalysisReport,
  type VerificationStages,
} from "@merge-integrity/core";
import { enforceProtectedInputs, InputError, parseInputs, resolveRefs, type ActionInputs } from "./inputs.js";
import { renderSummary } from "./summary.js";
import { formatAnnotation, stopCommands, writeOutputs } from "./workflow.js";

export interface ActionIo {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
}

const MAX_ANNOTATIONS = 50;

function errorReport(code: string, message: string): AnalysisReport {
  return {
    schemaVersion: 1,
    status: "error",
    findings: [],
    ignoredFindings: [],
    redGreen: emptyRedGreen("skipped", "analysis did not start"),
    mutation: emptyMutation("skipped", "analysis did not start"),
    durationMs: 0,
    timings: {},
    notes: [],
    error: { code, stage: "action", message },
  };
}

/**
 * `mode: doctor`: report whether this repository is supported, without analysing a pull request and without
 * running any repository code. It never fails the job (exit 0) so it can be added to an existing workflow, or run
 * from `workflow_dispatch`, before the check is enforced.
 */
async function runPreflight(io: ActionIo, commands: { stop: string; resume: string }, inputs: ActionInputs): Promise<number> {
  const { env } = io;
  try {
    const report = await runDoctor({
      cwd: env.GITHUB_WORKSPACE ?? process.cwd(),
      ...(inputs.workingDirectory === undefined ? {} : { workingDirectory: inputs.workingDirectory }),
      ...(inputs.config === undefined ? {} : { configPath: inputs.config }),
      ...(inputs.framework === undefined ? {} : { framework: inputs.framework }),
    });
    io.stdout(renderDoctorText(report));
    io.stdout(`${commands.resume}\n`);
    io.stdout(
      `${formatAnnotation({
        level: report.verdict === "unsupported" ? "warning" : "notice",
        title: `Merge Integrity preflight: ${VERDICT_LABEL[report.verdict]}`,
        message: terminalText(
          report.checks
            .filter((c) => c.level !== "ok")
            .map((c) => `${c.id}: ${c.message}`)
            .join(" | ") || "no problems found",
          1000,
        ),
      })}\n`,
    );
    try {
      if (env.GITHUB_OUTPUT) {
        writeOutputs(env.GITHUB_OUTPUT, {
          status: report.verdict,
          "blocker-count": String(report.checks.filter((c) => c.level === "fail").length),
          "warning-count": String(report.checks.filter((c) => c.level === "warn").length),
          "report-path": "",
        });
      }
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderDoctorSummary(report));
    } catch (error) {
      io.stdout(`${formatAnnotation({ level: "warning", message: `could not write action outputs: ${terminalText((error as Error).message)}` })}\n`);
    }
    return 0;
  } catch (error) {
    io.stdout(`Merge Integrity preflight: could not run: ${terminalText((error as Error).message, 1000)}\n`);
    io.stdout(`${commands.resume}\n`);
    io.stdout(`${formatAnnotation({ level: "warning", title: "Merge Integrity preflight", message: terminalText((error as Error).message, 1000) })}\n`);
    return 0;
  }
}

/**
 * Run the Action. Returns the process exit code: 0 success, 1 BLOCK (or WARN when the base-branch policy sets
 * `warningsBlockMerge`), 2 ERROR. Only high-confidence tampering rules block by default; advisory findings are
 * reported as warning annotations for review.
 */
export async function runAction(io: ActionIo, stages?: VerificationStages): Promise<number> {
  const { env } = io;
  let report: AnalysisReport;
  let policy = DEFAULT_CONFIG.policy;

  const commands = stopCommands();
  io.stdout(`${commands.stop}\n`);
  try {
    const inputs = parseInputs(env);
    if (inputs.mode === "doctor") {
      // `mode: doctor` is refused on pull_request/merge_group: it makes no merge decision.
      enforceProtectedInputs(env.GITHUB_EVENT_NAME ?? "", inputs);
      return await runPreflight(io, commands, inputs);
    }
    const refs = resolveRefs(env, inputs);
    const outcome = await runCheck(
      {
        cwd: env.GITHUB_WORKSPACE ?? process.cwd(),
        baseRef: refs.baseRef,
        headRef: refs.headRef,
        workingDirectory: inputs.workingDirectory,
        framework: inputs.framework,
        configPath: inputs.config,
        configSource: inputs.configSource ?? "base",
        redGreen: inputs.redGreen === false ? false : undefined,
        mutation: inputs.mutation,
      },
      stages,
    );
    report = outcome.report;
    policy = outcome.config.policy;
  } catch (error) {
    report = errorReport(error instanceof InputError ? "ACTION_INPUT" : "ACTION_FAILED", (error as Error).message);
  }
  // Untrusted text is printed only while workflow commands are suspended.
  io.stdout(renderText(report));
  io.stdout(`${commands.resume}\n`);

  const exitCode = exitCodeFor(report.status, policy);
  let reportPath = "";
  try {
    const dir = join(env.RUNNER_TEMP ?? join(env.GITHUB_WORKSPACE ?? process.cwd(), ".merge-integrity"), "merge-integrity");
    mkdirSync(dir, { recursive: true });
    reportPath = join(dir, "report.json");
    writeFileSync(reportPath, renderJson(report));
  } catch (error) {
    io.stdout(`${formatAnnotation({ level: "warning", message: `could not write the JSON report: ${terminalText((error as Error).message)}` })}\n`);
  }

  let annotations = 0;
  for (const finding of report.findings) {
    if (annotations >= MAX_ANNOTATIONS) break;
    annotations++;
    io.stdout(
      `${formatAnnotation({
        level: finding.severity === "block" ? "error" : "warning",
        title: `${finding.ruleId}: ${finding.title}`,
        message: terminalText(finding.message, 1000),
        ...(finding.file === undefined ? {} : { file: finding.file }),
        ...(finding.startLine === undefined ? {} : { line: finding.startLine }),
      })}\n`,
    );
  }
  if (report.status === "error") {
    io.stdout(`${formatAnnotation({ level: "error", title: "Merge Integrity: ERROR", message: `No merge decision was made: ${terminalText(report.error?.message ?? "unknown error", 1000)}` })}\n`);
  }

  const blockers = report.findings.filter((f) => f.severity === "block").length;
  const warnings = report.findings.filter((f) => f.severity === "warn").length;
  try {
    if (env.GITHUB_OUTPUT) {
      writeOutputs(env.GITHUB_OUTPUT, {
        status: report.status,
        "blocker-count": String(blockers),
        "warning-count": String(warnings),
        "report-path": reportPath,
      });
    }
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(report));
  } catch (error) {
    io.stdout(`${formatAnnotation({ level: "error", message: `could not write action outputs: ${terminalText((error as Error).message)}` })}\n`);
    return 2;
  }
  return exitCode;
}
