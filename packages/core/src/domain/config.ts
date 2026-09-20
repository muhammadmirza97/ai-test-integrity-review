import type { RuleId, Severity } from "./finding.js";

export type FrameworkSetting = "auto" | "jest" | "vitest";
export type Framework = "jest" | "vitest";

export interface IgnoreEntry {
  rule: RuleId;
  path: string;
  reason: string;
}

export interface PolicyConfig {
  warningsBlockMerge: boolean;
}

export interface MergeIntegrityConfig {
  version: 1;
  workingDirectory: string;
  framework: FrameworkSetting;
  policy: PolicyConfig;
  redGreen: { enabled: boolean; timeoutSeconds: number };
  mutation: { enabled: boolean; timeoutSeconds: number; maxMutants: number };
  /** Extra environment variable names passed to the project's tests (everything else is withheld). */
  testEnvironment: { passthrough: string[] };
  rules: Record<RuleId, Severity>;
  ignore: IgnoreEntry[];
}
