import { resolve } from "node:path";
import type { Framework } from "../domain/config.js";

/**
 * Classification of test-runner output. This is the heart of red/green trust:
 * only a genuine assertion failure may count as RED, and only a clean, consistent run may count as GREEN.
 *
 * Evidence (probed against Jest 30 and Vitest 5, see docs/RED_GREEN.md):
 * - Jest attaches `failureDetails[].matcherResult` to `expect` failures only; TypeErrors, thrown errors and
 *   test timeouts have no matcherResult. A suite that fails to import/compile has zero assertion results.
 *   `process.exit()` inside a test ends Jest with exit code 0 and no report.
 * - Vitest reports errors as `name: message` strings. Chai/`node:assert` failures start with `AssertionError`,
 *   snapshot mismatches with "Error: Snapshot `...` mismatched". Unhandled errors produce exit code 1 with
 *   `success: true`.
 */

export interface RunnerProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | undefined;
  json: unknown;
  stderr: string;
}

export type TestOutcome = "passed" | "assertion-failed" | "error" | "skipped";

export interface FileResult {
  suiteError?: string;
  tests: { name: string; path: string[] | undefined; outcome: TestOutcome; message?: string }[];
}

export interface ParsedRun {
  process: "completed" | "timeout" | "crash";
  crashReason?: string;
  /** Exit status and report disagree (e.g. Vitest unhandled errors): results cannot be trusted as GREEN. */
  inconsistent?: string;
  files: Map<string, FileResult>;
  noTestsFound: boolean;
}

export type FileClassificationKind =
  | "passed"
  | "assertion-failure"
  | "runtime-error"
  | "setup-error"
  | "not-collected"
  | "no-tests"
  | "timeout"
  | "crash";

export interface FileClassification {
  kind: FileClassificationKind;
  detail: string;
}

export function normalizeReportPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const VITEST_ASSERTION = [/^AssertionError(\s\[ERR_ASSERTION\])?:/, /^Error: Snapshot `[^`\n]*` mismatched/];

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyJestTest(test: Record<string, unknown>): { outcome: TestOutcome; message?: string } {
  const status = test.status;
  if (status === "passed") return { outcome: "passed" };
  if (status === "pending" || status === "skipped" || status === "todo" || status === "disabled") return { outcome: "skipped" };
  const messages = Array.isArray(test.failureMessages) ? test.failureMessages.filter((m): m is string => typeof m === "string") : [];
  const details = Array.isArray(test.failureDetails) ? test.failureDetails : [];
  const message = firstLine(messages[0] ?? "unknown failure");
  const genuine = details.length > 0 && details.every((d) => isRecord(d) && isRecord(d.matcherResult) && d.matcherResult.pass === false);
  return { outcome: status === "failed" && genuine ? "assertion-failed" : "error", message };
}

function classifyVitestTest(test: Record<string, unknown>): { outcome: TestOutcome; message?: string } {
  const status = test.status;
  if (status === "passed") return { outcome: "passed" };
  if (status === "pending" || status === "skipped" || status === "todo") return { outcome: "skipped" };
  const messages = Array.isArray(test.failureMessages) ? test.failureMessages.filter((m): m is string => typeof m === "string") : [];
  const message = firstLine(messages[0] ?? "unknown failure");
  const genuine = status === "failed" && messages.length > 0 && messages.every((m) => VITEST_ASSERTION.some((re) => re.test(m)));
  return { outcome: genuine ? "assertion-failed" : "error", message };
}

export function parseRunnerJson(framework: Framework, result: RunnerProcessResult): ParsedRun {
  const files = new Map<string, FileResult>();
  const noTestsFound = /No tests found|No test files found/i.test(result.stderr);
  if (result.timedOut) return { process: "timeout", files, noTestsFound };
  if (result.spawnError !== undefined) return { process: "crash", crashReason: `could not start the test runner: ${result.spawnError}`, files, noTestsFound };
  if (result.signal !== null || result.exitCode === null) {
    return { process: "crash", crashReason: `test runner terminated by signal ${result.signal ?? "unknown"}`, files, noTestsFound };
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { process: "crash", crashReason: `test runner exited with unexpected code ${result.exitCode}`, files, noTestsFound };
  }
  const json = result.json;
  if (json === undefined) {
    return { process: "crash", crashReason: `test runner exited with code ${result.exitCode} without writing a report`, files, noTestsFound };
  }
  if (!isRecord(json) || !Array.isArray(json.testResults)) {
    return { process: "crash", crashReason: "test runner report is malformed", files, noTestsFound };
  }

  let anyFailure = false;
  for (const suite of json.testResults) {
    if (!isRecord(suite) || typeof suite.name !== "string" || !Array.isArray(suite.assertionResults)) {
      return { process: "crash", crashReason: "test runner report is malformed", files: new Map(), noTestsFound };
    }
    const tests = suite.assertionResults
      .filter(isRecord)
      .map((t) => ({
        name: typeof t.fullName === "string" ? t.fullName : String(t.title ?? ""),
        path:
          Array.isArray(t.ancestorTitles) && t.ancestorTitles.every((a) => typeof a === "string") && typeof t.title === "string"
            ? [...(t.ancestorTitles as string[]), t.title]
            : undefined,
        ...(framework === "jest" ? classifyJestTest(t) : classifyVitestTest(t)),
      }));
    const hasFailedTest = tests.some((t) => t.outcome === "assertion-failed" || t.outcome === "error");
    const message = typeof suite.message === "string" ? suite.message : "";
    let suiteError: string | undefined;
    if (suite.status === "failed" && !hasFailedTest) {
      suiteError = firstLine(message.replace(/^\s*●\s*Test suite failed to run\s*/m, "").trim()) || "test file failed to run";
    } else if (framework === "vitest" && message.trim() !== "") {
      suiteError = firstLine(message.trim());
    }
    if (hasFailedTest || suiteError) anyFailure = true;
    files.set(normalizeReportPath(suite.name), { ...(suiteError ? { suiteError } : {}), tests });
  }

  const parsed: ParsedRun = { process: "completed", files, noTestsFound };
  if (result.exitCode === 0 && anyFailure) parsed.inconsistent = "runner exited 0 although the report contains failures";
  if (result.exitCode === 0 && anyFailure) {
    return { process: "crash", crashReason: parsed.inconsistent, files, noTestsFound };
  }
  if (result.exitCode === 1 && !anyFailure && files.size > 0) {
    parsed.inconsistent = "runner exited 1 although every reported test passed (unhandled error or failing hook outside tests)";
  }
  return parsed;
}

export function classifyFile(run: ParsedRun, file: string): FileClassification {
  if (run.process === "timeout") return { kind: "timeout", detail: "the test run exceeded its time budget" };
  if (run.process === "crash") {
    if (run.noTestsFound && run.files.size === 0) return { kind: "not-collected", detail: "the test runner did not collect this file" };
    return { kind: "crash", detail: run.crashReason ?? "test runner crashed" };
  }
  const result = run.files.get(normalizeReportPath(file));
  if (!result) return { kind: "not-collected", detail: "the test runner did not collect this file (excluded by its configuration?)" };
  if (result.suiteError) return { kind: "setup-error", detail: `the file failed to load or set up: ${result.suiteError}` };
  if (run.inconsistent) return { kind: "runtime-error", detail: run.inconsistent };

  const executed = result.tests.filter((t) => t.outcome !== "skipped");
  if (executed.length === 0) return { kind: "no-tests", detail: "no tests executed in this file" };
  const assertionFailures = executed.filter((t) => t.outcome === "assertion-failed");
  const errors = executed.filter((t) => t.outcome === "error");
  if (assertionFailures.length > 0) {
    return {
      kind: "assertion-failure",
      detail: `${assertionFailures.length} test(s) failed an assertion${errors.length > 0 ? `; ${errors.length} other test(s) errored` : ""}: ${assertionFailures[0]?.message ?? ""}`,
    };
  }
  if (errors.length > 0) {
    return { kind: "runtime-error", detail: `${errors.length} test(s) failed with a non-assertion error: ${errors[0]?.message ?? ""}` };
  }
  return { kind: "passed", detail: `${executed.length} test(s) passed` };
}

export type TestCaseClassificationKind =
  | "passed"
  | "assertion-failure"
  | "runtime-error"
  | "skipped"
  | "not-found"
  | "ambiguous"
  | FileClassificationKind;

export interface TestCaseClassification {
  kind: TestCaseClassificationKind;
  detail: string;
}

/**
 * Classify one test case (identified by its suite path and name) within a run.
 * Run- and file-level failures (timeout, crash, setup error, not collected, inconsistent report) apply to every
 * test in the file. A test is matched only by its exact static name path; dynamic or duplicate names are not guessed.
 */
export function classifyTestCase(run: ParsedRun, file: string, namePath: readonly string[]): TestCaseClassification {
  const fileLevel = classifyFile(run, file);
  if (["timeout", "crash", "setup-error", "not-collected"].includes(fileLevel.kind)) return fileLevel;
  if (run.inconsistent) return { kind: "runtime-error", detail: run.inconsistent };
  const result = run.files.get(normalizeReportPath(file));
  const key = JSON.stringify(namePath);
  const matches = (result?.tests ?? []).filter((t) => t.path !== undefined && JSON.stringify(t.path) === key);
  if (matches.length === 0) return { kind: "not-found", detail: "the test was not reported under its static name" };
  const outcomes = new Set(matches.map((m) => m.outcome));
  if (outcomes.size > 1) return { kind: "ambiguous", detail: "several tests share this name with different results" };
  const first = matches[0] as FileResult["tests"][number];
  switch (first.outcome) {
    case "passed":
      return { kind: "passed", detail: "passed" };
    case "skipped":
      return { kind: "skipped", detail: "the test did not run" };
    case "assertion-failed":
      return { kind: "assertion-failure", detail: first.message ?? "assertion failure" };
    default:
      return { kind: "runtime-error", detail: first.message ?? "non-assertion error" };
  }
}
