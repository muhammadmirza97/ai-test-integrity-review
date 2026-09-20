import picomatch from "picomatch";
import type { IgnoreEntry, PolicyConfig } from "../domain/config.js";
import type { Finding, IgnoredFinding } from "../domain/finding.js";
import { TRUSTWORTHY_STAGE_STATUSES, type AnalysisError, type OverallStatus, type StageStatus } from "../domain/result.js";
import { isSafeRelativePath } from "../fs/paths.js";

export interface StatusInput {
  findings: readonly Finding[];
  error?: AnalysisError | undefined;
  stages: readonly StageStatus[];
}

/**
 * Decide the overall status. Fail closed: an error, a failed stage, or an unknown stage state is ERROR;
 * a skipped stage is acceptable only when a blocking finding already decided the result.
 */
export function evaluateStatus(input: StatusInput): OverallStatus {
  if (input.error) return "error";
  const hasBlock = input.findings.some((f) => f.severity === "block");
  for (const stage of input.stages) {
    if (stage === "skipped" && hasBlock) continue;
    if (!TRUSTWORTHY_STAGE_STATUSES.includes(stage)) return "error";
  }
  if (hasBlock) return "block";
  if (input.findings.some((f) => f.severity === "warn")) return "warn";
  if (input.findings.some((f) => f.severity !== "block" && f.severity !== "warn")) return "error";
  return "pass";
}

export function exitCodeFor(status: OverallStatus, policy: PolicyConfig): 0 | 1 | 2 {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return policy.warningsBlockMerge ? 1 : 0;
    case "block":
      return 1;
    default:
      return 2;
  }
}

export function applyIgnorePolicy(
  findings: readonly Finding[],
  ignore: readonly IgnoreEntry[],
): { findings: Finding[]; ignoredFindings: IgnoredFinding[] } {
  const matchers = ignore.map((entry) => ({ entry, match: picomatch(entry.path, { dot: true }) }));
  const kept: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  for (const finding of findings) {
    const file = finding.file;
    const hit =
      file !== undefined && isSafeRelativePath(file)
        ? matchers.find(({ entry, match }) => entry.rule === finding.ruleId && match(file))
        : undefined;
    if (hit) {
      ignored.push({ ...finding, ignoreReason: hit.entry.reason, ignorePath: hit.entry.path });
    } else {
      kept.push(finding);
    }
  }
  return { findings: kept, ignoredFindings: ignored };
}
