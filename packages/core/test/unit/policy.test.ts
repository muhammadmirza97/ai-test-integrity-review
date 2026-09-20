import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfigText } from "../../src/config/parse.js";
import { RULE_IDS, RULES, type Finding, type RuleId } from "../../src/domain/finding.js";
import { applyIgnorePolicy, evaluateStatus, exitCodeFor } from "../../src/policy/evaluate.js";

const block: Finding = { ruleId: "MI001_TEST_SKIPPED", severity: "block", title: "t", message: "m", file: "src/a.test.ts" };
const warn: Finding = { ruleId: "MI104_TEST_DELETED", severity: "warn", title: "t", message: "m", file: "tests/legacy/x.test.ts" };

describe("evaluateStatus", () => {
  it("returns pass only when there is no finding, no error and all stages are trustworthy", () => {
    expect(evaluateStatus({ findings: [], stages: ["completed", "disabled", "not-applicable"] })).toBe("pass");
  });

  it("prioritises error over block and warn", () => {
    expect(
      evaluateStatus({ findings: [block, warn], error: { code: "X", message: "m", stage: "git" }, stages: [] }),
    ).toBe("error");
  });

  it("returns error when any stage failed even without an explicit error object", () => {
    expect(evaluateStatus({ findings: [], stages: ["completed", "error"] })).toBe("error");
  });

  it("returns error when a stage is in an unknown state", () => {
    expect(evaluateStatus({ findings: [], stages: ["weird" as never] })).toBe("error");
  });

  it("does not pass when a stage was skipped because of blockers unless a blocker exists", () => {
    expect(evaluateStatus({ findings: [], stages: ["skipped"] })).toBe("error");
    expect(evaluateStatus({ findings: [block], stages: ["skipped"] })).toBe("block");
  });

  it("returns block over warn", () => {
    expect(evaluateStatus({ findings: [warn, block], stages: [] })).toBe("block");
    expect(evaluateStatus({ findings: [warn], stages: [] })).toBe("warn");
  });
});

describe("exitCodeFor", () => {
  it("maps statuses to documented exit codes", () => {
    expect(exitCodeFor("pass", DEFAULT_CONFIG.policy)).toBe(0);
    expect(exitCodeFor("warn", DEFAULT_CONFIG.policy)).toBe(0);
    expect(exitCodeFor("warn", { warningsBlockMerge: true })).toBe(1);
    expect(exitCodeFor("block", DEFAULT_CONFIG.policy)).toBe(1);
    expect(exitCodeFor("error", DEFAULT_CONFIG.policy)).toBe(2);
    expect(exitCodeFor("nonsense" as never, DEFAULT_CONFIG.policy)).toBe(2);
  });
});

const HIGH_CONFIDENCE_TAMPERING = ["MI001_TEST_SKIPPED", "MI002_TEST_FOCUSED", "MI004_ASSERTION_WEAKENED", "MI005_TEST_COMMAND_BYPASS", "MI106_POLICY_WEAKENED"];
const ADVISORY = [
  "MI003_ASSERTION_REMOVED",
  "MI006_REGRESSION_TEST_NON_DISCRIMINATING",
  "MI101_ASSERTION_CHANGE_AMBIGUOUS",
  "MI102_MUTATION_SURVIVED",
  "MI103_RED_GREEN_INCONCLUSIVE",
  "MI104_TEST_DELETED",
  "MI105_COVERAGE_SCOPE_REDUCED",
  "MI107_TEST_DISCOVERY_UNSUPPORTED",
];

/** A finding with the severity the default policy assigns to its rule. */
const defaultFinding = (ruleId: RuleId): Finding => ({ ruleId, severity: DEFAULT_CONFIG.rules[ruleId], title: "t", message: "m", file: "test/a.test.ts" });

describe("default enforcement tiers", () => {
  it("blocks by default only for high-confidence tampering; everything else is advisory", () => {
    expect(RULE_IDS.filter((id) => RULES[id].defaultSeverity === "block").sort()).toEqual([...HIGH_CONFIDENCE_TAMPERING].sort());
    expect(RULE_IDS.filter((id) => RULES[id].defaultSeverity === "warn").sort()).toEqual([...ADVISORY].sort());
  });

  it.each(ADVISORY)("%s alone is WARN and does not fail the check under the default policy", (ruleId) => {
    const findings = [defaultFinding(ruleId as RuleId)];
    const status = evaluateStatus({ findings, stages: [] });
    expect(status).toBe("warn");
    expect(exitCodeFor(status, DEFAULT_CONFIG.policy)).toBe(0);
  });

  it.each(HIGH_CONFIDENCE_TAMPERING)("%s BLOCKs and fails the check under the default policy", (ruleId) => {
    const findings = [defaultFinding(ruleId as RuleId)];
    const status = evaluateStatus({ findings, stages: [] });
    expect(status).toBe("block");
    expect(exitCodeFor(status, DEFAULT_CONFIG.policy)).toBe(1);
  });

  it("lets a base-branch owner opt into stricter enforcement for advisory rules", () => {
    const parsed = parseConfigText("version: 1\nrules:\n  MI103_RED_GREEN_INCONCLUSIVE: block\n  MI006_REGRESSION_TEST_NON_DISCRIMINATING: block\n", "cfg");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.rules.MI103_RED_GREEN_INCONCLUSIVE).toBe("block");
    expect(parsed.config.rules.MI006_REGRESSION_TEST_NON_DISCRIMINATING).toBe("block");
    expect(parsed.config.rules.MI107_TEST_DISCOVERY_UNSUPPORTED).toBe("warn");
    expect(exitCodeFor("warn", { warningsBlockMerge: true })).toBe(1);
  });

  it("still fails the check on ERROR: an analysis that could not complete is never a pass", () => {
    expect(exitCodeFor(evaluateStatus({ findings: [], stages: ["error"] }), DEFAULT_CONFIG.policy)).toBe(2);
  });
});

describe("applyIgnorePolicy", () => {
  it("moves matching findings to ignoredFindings with the reason attached", () => {
    const result = applyIgnorePolicy(
      [block, warn],
      [{ rule: "MI104_TEST_DELETED", path: "tests/legacy/**", reason: "retiring legacy suite" }],
    );
    expect(result.findings).toEqual([block]);
    expect(result.ignoredFindings).toHaveLength(1);
    expect(result.ignoredFindings[0]?.ignoreReason).toBe("retiring legacy suite");
  });

  it("does not ignore findings for a different rule or path", () => {
    const result = applyIgnorePolicy(
      [block, warn],
      [
        { rule: "MI104_TEST_DELETED", path: "src/**", reason: "r" },
        { rule: "MI002_TEST_FOCUSED", path: "src/**", reason: "r" },
      ],
    );
    expect(result.findings).toEqual([block, warn]);
    expect(result.ignoredFindings).toEqual([]);
  });

  it("never ignores findings without a file", () => {
    const noFile: Finding = { ruleId: "MI104_TEST_DELETED", severity: "warn", title: "t", message: "m" };
    const result = applyIgnorePolicy([noFile], [{ rule: "MI104_TEST_DELETED", path: "**/x", reason: "r" }]);
    expect(result.findings).toEqual([noFile]);
  });

  it("does not let traversal-looking paths match an ignore glob", () => {
    const sneaky: Finding = { ...warn, file: "tests/legacy/../../src/a.test.ts" };
    const result = applyIgnorePolicy([sneaky], [{ rule: "MI104_TEST_DELETED", path: "tests/legacy/**", reason: "r" }]);
    expect(result.findings).toEqual([sneaky]);
  });
});
