import type { DoctorReport } from "../environment/doctor.js";
import { VERDICT_LABEL } from "../environment/doctor.js";
import type { AnalysisReport, MutationSummary, RedGreenSummary } from "../domain/result.js";
import { markdownText, terminalText } from "./sanitize.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function redGreenLine(summary: RedGreenSummary): string {
  switch (summary.status) {
    case "completed": {
      const parts = [`${plural(summary.verifiedTests, "changed test")} verified`];
      if (summary.nonDiscriminatingTests > 0) parts.push(`${summary.nonDiscriminatingTests} non-discriminating`);
      if (summary.inconclusiveTests > 0) parts.push(`${summary.inconclusiveTests} inconclusive`);
      return `${parts.join(", ")} (${plural(summary.files.length, "file")})`;
    }
    case "disabled":
      return "disabled";
    case "not-applicable":
      return `not applicable${summary.reason ? ` (${terminalText(summary.reason, 200)})` : ""}`;
    case "skipped":
      return "skipped (blocking findings already decide the result)";
    default:
      return `ERROR${summary.reason ? ` (${terminalText(summary.reason, 300)})` : ""}`;
  }
}

export function mutationLine(summary: MutationSummary): string {
  switch (summary.status) {
    case "completed": {
      const detected = summary.killed + summary.timedOut;
      const relevant = detected + summary.survived + summary.noCoverage;
      let line = `${detected}/${relevant} relevant mutants killed`;
      if (summary.sampled) line += ` (sampled ${summary.attempted} of ${summary.candidates} by max-mutant budget)`;
      if (summary.invalid > 0) line += `, ${summary.invalid} invalid`;
      return line;
    }
    case "disabled":
      return "disabled";
    case "not-applicable":
      return `not applicable${summary.reason ? ` (${terminalText(summary.reason, 200)})` : ""}`;
    case "skipped":
      return "skipped (blocking findings already decide the result)";
    default:
      return `ERROR${summary.reason ? ` (${terminalText(summary.reason, 300)})` : ""}`;
  }
}

function location(file: string | undefined, line: number | undefined): string {
  if (file === undefined) return "";
  return terminalText(line === undefined ? file : `${file}:${line}`, 300);
}

export function renderText(report: AnalysisReport): string {
  const out: string[] = [`Merge Integrity: ${report.status.toUpperCase()}`];

  if (report.status === "error") {
    out.push("", "Verification could not complete.");
    if (report.error) out.push(`Reason: ${terminalText(report.error.message, 1000)}`);
    out.push("", "No merge decision was made.");
  }

  const blockers = report.findings.filter((f) => f.severity === "block");
  const warnings = report.findings.filter((f) => f.severity === "warn");
  out.push(`${plural(blockers.length, "blocker")} · ${plural(warnings.length, "warning")}`);

  for (const finding of [...blockers, ...warnings]) {
    out.push("", `${finding.severity.toUpperCase()} ${finding.ruleId}`);
    const where = location(finding.file, finding.startLine);
    if (where) out.push(where);
    out.push(terminalText(finding.message, 1000));
  }

  if (report.ignoredFindings.length > 0) {
    out.push("", `Ignored by policy: ${report.ignoredFindings.length}`);
    for (const ignored of report.ignoredFindings) {
      out.push(`  ${ignored.ruleId} ${location(ignored.file, ignored.startLine)} — ${terminalText(ignored.ignoreReason, 300)}`);
    }
  }

  out.push("", `Red/green: ${redGreenLine(report.redGreen)}`, `Mutation: ${mutationLine(report.mutation)}`);
  for (const note of report.notes) out.push(`Note: ${terminalText(note, 500)}`);
  const timings = Object.entries(report.timings)
    .map(([stage, ms]) => `${stage} ${(ms / 1000).toFixed(1)}s`)
    .join(", ");
  out.push(`Duration: ${(report.durationMs / 1000).toFixed(1)}s${timings ? ` (${timings})` : ""}`);
  return `${out.join("\n")}\n`;
}

export function renderJson(report: AnalysisReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const VERDICT_EXPLANATION: Record<DoctorReport["verdict"], string> = {
  supported: "This repository matches the alpha support envelope. Nothing blocking was found.",
  "supported-with-warnings":
    "The gate can run here, but some findings will be less useful or will appear as advisory warnings on every pull request.",
  unsupported:
    "This repository is not supported by this alpha as it is configured. Runs would fail with ERROR, which is not a claim that the repository is wrong.",
};

/** Preflight result for a terminal. Repository-derived text is made inert. */
export function renderDoctorText(report: DoctorReport): string {
  const out: string[] = [`Merge Integrity preflight: ${VERDICT_LABEL[report.verdict]}`, "", VERDICT_EXPLANATION[report.verdict], ""];
  for (const check of report.checks) {
    out.push(`[${check.level.padEnd(4)}] ${check.id}: ${terminalText(check.message, 500)}`);
    if (check.remedy !== undefined && check.level !== "ok") out.push(`         -> ${terminalText(check.remedy, 500)}`);
  }
  const fails = report.checks.filter((c) => c.level === "fail").length;
  const warns = report.checks.filter((c) => c.level === "warn").length;
  out.push("", `${fails} blocking, ${warns} advisory. See docs/ALPHA_SUPPORT_MATRIX.md and docs/TROUBLESHOOTING.md.`);
  return `${out.join("\n")}\n`;
}

export function renderDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Preflight result for a GitHub Step Summary. */
export function renderDoctorSummary(report: DoctorReport): string {
  const icon = { ok: "✅", warn: "⚠️", fail: "❌" } as const;
  const out: string[] = [
    `## Merge Integrity preflight: ${VERDICT_LABEL[report.verdict]}`,
    "",
    VERDICT_EXPLANATION[report.verdict],
    "",
    "| | Check | Detail |",
    "| --- | --- | --- |",
  ];
  for (const check of report.checks) {
    const detail = markdownText(check.message, 400) + (check.remedy !== undefined && check.level !== "ok" ? `<br>**What to do:** ${markdownText(check.remedy, 400)}` : "");
    out.push(`| ${icon[check.level]} | ${markdownText(check.id, 60)} | ${detail} |`);
  }
  out.push("", "This preflight never fails the job. See `docs/ALPHA_SUPPORT_MATRIX.md`.", "");
  return out.join("\n");
}
