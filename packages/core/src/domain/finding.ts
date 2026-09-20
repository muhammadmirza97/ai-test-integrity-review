export type Severity = "warn" | "block";

export interface RuleDefinition {
  readonly defaultSeverity: Severity;
  readonly title: string;
}

/**
 * Stable rule catalogue. IDs are part of the public contract (config, JSON report, annotations).
 *
 * Default severities follow two tiers (calibrated on 58 historical merged PRs, see CALIBRATION_RESULTS.md and
 * POLICY_RECALIBRATION.md):
 * - `block`: high-confidence, deterministic test tampering (skip/only, reviewed assertion weakening, test-command
 *   bypass) and weakening of the gate itself (MI106).
 * - `warn`: advisory test-quality evidence that is often legitimate or cannot be decided (assertion removal,
 *   red/green and mutation evidence, deleted tests, scope changes, unsupported discovery).
 * A base-branch policy may raise any rule to `block` or set `policy.warningsBlockMerge: true`.
 */
export const RULES = {
  MI001_TEST_SKIPPED: { defaultSeverity: "block", title: "Test skipped" },
  MI002_TEST_FOCUSED: { defaultSeverity: "block", title: "Test focused" },
  MI003_ASSERTION_REMOVED: { defaultSeverity: "warn", title: "Assertion removed" },
  MI004_ASSERTION_WEAKENED: { defaultSeverity: "block", title: "Assertion weakened" },
  MI005_TEST_COMMAND_BYPASS: { defaultSeverity: "block", title: "Test command bypass" },
  MI006_REGRESSION_TEST_NON_DISCRIMINATING: {
    defaultSeverity: "warn",
    title: "Regression test does not discriminate",
  },
  MI101_ASSERTION_CHANGE_AMBIGUOUS: { defaultSeverity: "warn", title: "Possible test weakening (unconfirmed)" },
  MI102_MUTATION_SURVIVED: { defaultSeverity: "warn", title: "Mutation survived" },
  MI103_RED_GREEN_INCONCLUSIVE: { defaultSeverity: "warn", title: "Red/green verification inconclusive" },
  MI104_TEST_DELETED: { defaultSeverity: "warn", title: "Test deleted" },
  MI105_COVERAGE_SCOPE_REDUCED: { defaultSeverity: "warn", title: "Verification scope reduced" },
  MI106_POLICY_WEAKENED: { defaultSeverity: "block", title: "Merge Integrity gate or policy weakened" },
  MI107_TEST_DISCOVERY_UNSUPPORTED: { defaultSeverity: "warn", title: "Test discovery could not be fully analysed" },
} as const satisfies Record<string, RuleDefinition>;

export type RuleId = keyof typeof RULES;

export const RULE_IDS = Object.keys(RULES) as RuleId[];

export function isRuleId(value: unknown): value is RuleId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RULES, value);
}

export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  message: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  evidence?: Record<string, unknown>;
}

export interface IgnoredFinding extends Finding {
  ignoreReason: string;
  ignorePath: string;
}

/** A rule-emitted finding before policy assigns its configured severity. */
export type RawFinding = Omit<Finding, "severity" | "title">;
