import { markdownText, mutationLine, redGreenLine, type AnalysisReport, type Finding } from "@merge-integrity/core";

const MAX_FINDINGS = 50;

/**
 * One quiet attribution line at the end of the Step Summary, so a reviewer who sees a finding can find out
 * what produced it. No advertising language, no tracking parameters, no telemetry: a plain repository link,
 * printed once per run, after the result.
 */
export const ATTRIBUTION = "[AI Test Integrity Review](https://github.com/muhammadmirza97/ai-test-integrity-review) · alpha";

function where(finding: Finding): string {
  if (finding.file === undefined) return "";
  return markdownText(finding.startLine === undefined ? finding.file : `${finding.file}:${finding.startLine}`, 300);
}

/** GitHub Step Summary. Every repository-derived string is escaped; nothing is rendered as raw HTML. */
export function renderSummary(report: AnalysisReport): string {
  const blockers = report.findings.filter((f) => f.severity === "block");
  const warnings = report.findings.filter((f) => f.severity === "warn");
  const lines: string[] = [
    `## Merge Integrity: ${report.status.toUpperCase()}`,
    "",
    `${blockers.length} blocker${blockers.length === 1 ? "" : "s"} · ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
    "",
  ];
  if (report.status === "error") {
    lines.push(`**Verification could not complete.** ${markdownText(report.error?.message ?? "unknown error", 1000)}`, "", "No merge decision was made.", "");
  } else if (report.status === "warn") {
    lines.push("Warnings are advisory evidence for a reviewer: they do not fail this check unless the base-branch policy makes them blocking.", "");
  }
  const shown = [...blockers, ...warnings].slice(0, MAX_FINDINGS);
  if (shown.length > 0) {
    lines.push("| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
    for (const f of shown) {
      lines.push(`| ${f.severity.toUpperCase()} | \`${f.ruleId}\` | ${where(f)} | ${markdownText(f.message, 600)} |`);
    }
    if (blockers.length + warnings.length > shown.length) lines.push("", `…and ${blockers.length + warnings.length - shown.length} more (see the JSON report).`);
    lines.push("");
  }
  lines.push(`- **Red/green:** ${markdownText(redGreenLine(report.redGreen), 400)}`, `- **Mutation:** ${markdownText(mutationLine(report.mutation), 400)}`);
  if (report.ignoredFindings.length > 0) {
    lines.push(`- **Ignored by policy:** ${report.ignoredFindings.length}`);
    for (const f of report.ignoredFindings.slice(0, MAX_FINDINGS)) {
      lines.push(`  - \`${f.ruleId}\` ${where(f)} — ${markdownText(f.ignoreReason, 300)}`);
    }
  }
  for (const note of report.notes) lines.push(`- ${markdownText(note, 300)}`);
  lines.push(`- **Duration:** ${(report.durationMs / 1000).toFixed(1)}s`, "", "---", "", ATTRIBUTION, "");
  return `${lines.join("\n")}\n`;
}
