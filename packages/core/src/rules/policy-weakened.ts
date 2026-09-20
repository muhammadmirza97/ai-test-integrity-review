import type { MergeIntegrityConfig } from "../domain/config.js";
import { RULE_IDS, type RawFinding } from "../domain/finding.js";

/** Reasons the proposed (head) policy is weaker than the base policy. Empty when it is not weaker. */
export function policyWeakenings(base: MergeIntegrityConfig, head: MergeIntegrityConfig): string[] {
  const reasons: string[] = [];
  for (const id of RULE_IDS) {
    if (base.rules[id] === "block" && head.rules[id] === "warn") reasons.push(`${id} lowered from block to warn`);
  }
  if (base.redGreen.enabled && !head.redGreen.enabled) reasons.push("red/green verification disabled");
  if (base.mutation.enabled && !head.mutation.enabled) reasons.push("mutation testing disabled");
  if (head.mutation.maxMutants < base.mutation.maxMutants) {
    reasons.push(`mutation.maxMutants reduced from ${base.mutation.maxMutants} to ${head.mutation.maxMutants}`);
  }
  if (base.policy.warningsBlockMerge && !head.policy.warningsBlockMerge) reasons.push("warningsBlockMerge disabled");
  const baseIgnores = new Set(base.ignore.map((i) => `${i.rule}\0${i.path}`));
  const added = head.ignore.filter((i) => !baseIgnores.has(`${i.rule}\0${i.path}`));
  if (added.length > 0) reasons.push(`ignore entries added: ${added.map((i) => `${i.rule} ${i.path}`).join(", ")}`);
  const passthrough = head.testEnvironment.passthrough.filter((n) => !base.testEnvironment.passthrough.includes(n));
  if (passthrough.length > 0) reasons.push(`environment variables newly passed to tests: ${passthrough.join(", ")}`);
  if (base.workingDirectory !== head.workingDirectory) {
    reasons.push(`workingDirectory changed from "${base.workingDirectory}" to "${head.workingDirectory}"`);
  }
  if (base.framework !== head.framework) reasons.push(`framework changed from ${base.framework} to ${head.framework}`);
  return reasons;
}

export function comparePolicies(
  file: string,
  base: MergeIntegrityConfig,
  head: MergeIntegrityConfig | "invalid",
  appliedSource: "base" | "head",
): RawFinding[] {
  if (head === "invalid") {
    return appliedSource === "base"
      ? [{ ruleId: "MI106_POLICY_WEAKENED", file, message: "The pull request's proposed Merge Integrity configuration is invalid (not applied)." }]
      : [];
  }
  const reasons = policyWeakenings(base, head);
  if (reasons.length === 0) return [];
  const suffix =
    appliedSource === "base"
      ? "The base-branch policy was applied; the proposed change takes effect only after merge."
      : "The weaker pull-request policy WAS applied because config-source is head.";
  return [
    {
      ruleId: "MI106_POLICY_WEAKENED",
      file,
      message: `The pull request weakens the Merge Integrity policy: ${reasons.join("; ")}. ${suffix}`,
      evidence: { reasons, appliedSource },
    },
  ];
}
