export * from "./domain/finding.js";
export * from "./domain/result.js";
export type * from "./domain/config.js";
export { DEFAULT_CONFIG, DEFAULT_CONFIG_PATH, parseConfigText, type ConfigParseResult } from "./config/parse.js";
export { applyIgnorePolicy, evaluateStatus, exitCodeFor } from "./policy/evaluate.js";
export {
  runDoctor,
  isSupportedNode,
  verdictFor,
  VERDICT_LABEL,
  type CheckLevel,
  type DoctorCheck,
  type DoctorReport,
  type DoctorOptions,
  type SupportVerdict,
} from "./environment/doctor.js";
export {
  analyzeTestScript,
  detectPackageManager,
  detectVitestBrowserMode,
  frameworkVersionFinding,
  packageManagerFinding,
  testScriptFindings,
  browserModeFinding,
  VALIDATED_FRAMEWORK_VERSIONS,
  type CompatibilityFinding,
  type CompatibilityLevel,
  type PackageManagerDetection,
  type TestScriptAnalysis,
} from "./environment/compatibility.js";
export { installInterruptCleanup } from "./red-green/worktree.js";
export {
  defaultStages,
  runCheck,
  type CheckOptions,
  type CheckOutcome,
  type StageContext,
  type StageResult,
  type VerificationStages,
} from "./check/run-check.js";
export { renderJson, renderText, redGreenLine, mutationLine, renderDoctorText, renderDoctorJson, renderDoctorSummary } from "./report/text.js";
export { markdownText, terminalText } from "./report/sanitize.js";
