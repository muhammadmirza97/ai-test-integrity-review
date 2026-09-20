import { describe, expect, it } from "vitest";
import { classifyFile, parseRunnerJson, type RunnerProcessResult } from "../../src/red-green/classify-failure.js";

const FILE = "/tmp/wt/test/a.test.ts";

function proc(partial: Partial<RunnerProcessResult>): RunnerProcessResult {
  return { exitCode: 1, signal: null, timedOut: false, spawnError: undefined, json: undefined, stderr: "", ...partial };
}

const jestSuite = (tests: unknown[], extra: Record<string, unknown> = {}) => ({
  numRuntimeErrorTestSuites: 0,
  testResults: [{ name: FILE, status: tests.some((t) => (t as { status: string }).status === "failed") ? "failed" : "passed", message: "", assertionResults: tests, ...extra }],
});

const jestAssertion = { status: "failed", fullName: "a", failureMessages: ["Error: expect(received).toBe(expected)"], failureDetails: [{ matcherResult: { pass: false } }] };
const jestTypeError = { status: "failed", fullName: "b", failureMessages: ["TypeError: x is not a function"], failureDetails: [{}] };
const jestFakeAssertion = { status: "failed", fullName: "c", failureMessages: ["Expected value undefined"], failureDetails: [{ message: "expected 1 to be 2" }] };
const passed = { status: "passed", fullName: "p", failureMessages: [], failureDetails: [] };
const skipped = { status: "pending", fullName: "s", failureMessages: [] };

describe("Jest classification", () => {
  const classify = (json: unknown, extra: Partial<RunnerProcessResult> = {}) =>
    classifyFile(parseRunnerJson("jest", proc({ json, ...extra })), FILE);

  it("passes only with exit code 0, a report and executed passing tests", () => {
    expect(classify(jestSuite([passed, skipped]), { exitCode: 0 }).kind).toBe("passed");
  });

  it("treats a matcher failure as an assertion failure", () => {
    expect(classify(jestSuite([jestAssertion, passed])).kind).toBe("assertion-failure");
  });

  it("treats TypeError and thrown errors as runtime errors, not RED", () => {
    expect(classify(jestSuite([jestTypeError])).kind).toBe("runtime-error");
  });

  it("does not trust an error that merely claims to be an assertion", () => {
    expect(classify(jestSuite([jestFakeAssertion])).kind).toBe("runtime-error");
  });

  it("counts RED when at least one genuine assertion failure exists alongside runtime errors", () => {
    expect(classify(jestSuite([jestAssertion, jestTypeError])).kind).toBe("assertion-failure");
  });

  it("classifies a suite that failed to run (import/compile error) as a setup error", () => {
    const json = { numRuntimeErrorTestSuites: 1, testResults: [{ name: FILE, status: "failed", message: "Test suite failed to run\nCannot find module", assertionResults: [] }] };
    expect(classify(json).kind).toBe("setup-error");
  });

  it("treats exit code 0 without a report (e.g. process.exit in a test) as a crash", () => {
    expect(classify(undefined, { exitCode: 0 }).kind).toBe("crash");
  });

  it("treats a timeout as timeout regardless of partial output", () => {
    expect(classify(jestSuite([passed]), { exitCode: null, timedOut: true, signal: "SIGKILL" }).kind).toBe("timeout");
  });

  it("treats exit 0 with failing tests as a crash (inconsistent report)", () => {
    expect(classify(jestSuite([jestAssertion]), { exitCode: 0 }).kind).toBe("crash");
  });

  it("treats a missing file in the report as not collected", () => {
    expect(classifyFile(parseRunnerJson("jest", proc({ json: { testResults: [] }, exitCode: 1 })), FILE).kind).toBe("not-collected");
    expect(classifyFile(parseRunnerJson("jest", proc({ json: undefined, exitCode: 1, stderr: "No tests found, exiting with code 1" })), FILE).kind).toBe("not-collected");
  });

  it("treats a file with only skipped tests as no-tests", () => {
    expect(classify(jestSuite([skipped]), { exitCode: 0 }).kind).toBe("no-tests");
  });

  it("treats unexpected exit codes, signals and spawn errors as crashes", () => {
    expect(classify(jestSuite([passed]), { exitCode: 134 }).kind).toBe("crash");
    expect(classify(undefined, { exitCode: null, signal: "SIGSEGV" }).kind).toBe("crash");
    expect(classify(undefined, { exitCode: null, spawnError: "ENOENT" }).kind).toBe("crash");
  });

  it("treats malformed report JSON as a crash", () => {
    expect(classify({ testResults: "nope" }, { exitCode: 0 }).kind).toBe("crash");
  });
});

describe("Vitest classification", () => {
  const vt = (tests: unknown[], message = "") => ({
    success: !tests.some((t) => (t as { status: string }).status === "failed"),
    testResults: [{ name: FILE.replace(/\\/g, "/"), status: "failed", message, assertionResults: tests }],
  });
  const classify = (json: unknown, extra: Partial<RunnerProcessResult> = {}) =>
    classifyFile(parseRunnerJson("vitest", proc({ json, ...extra })), FILE);

  it("recognises chai, node:assert and snapshot mismatches as assertion failures", () => {
    for (const message of [
      "AssertionError: expected 2 to be 3 // Object.is equality\n    at x",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal",
      "Error: Snapshot `x 1` mismatched\n    at y",
    ]) {
      expect(classify(vt([{ status: "failed", failureMessages: [message] }])).kind, message).toBe("assertion-failure");
    }
  });

  it("treats TypeError, generic errors, test timeouts and process.exit as runtime errors", () => {
    for (const message of [
      "TypeError: api.missing is not a function",
      "Error: boom",
      "Error: Test timed out in 500ms.",
      'Error: process.exit unexpectedly called with "0"',
    ]) {
      expect(classify(vt([{ status: "failed", failureMessages: [message] }])).kind, message).toBe("runtime-error");
    }
  });

  it("treats a suite-level message with no tests as a setup error", () => {
    expect(classify(vt([], "Cannot find module '../src/x'")).kind).toBe("setup-error");
  });

  it("does not pass a run whose report says success but whose exit code is non-zero (unhandled errors)", () => {
    const json = { success: true, testResults: [{ name: FILE, status: "passed", message: "", assertionResults: [{ status: "passed", failureMessages: [] }] }] };
    expect(classify(json, { exitCode: 1 }).kind).toBe("runtime-error");
  });

  it("treats an empty report as not collected", () => {
    expect(classify({ success: false, testResults: [] }, { exitCode: 1 }).kind).toBe("not-collected");
  });

  it("matches Windows and POSIX spellings of the same path", () => {
    const json = { success: true, testResults: [{ name: "C:/tmp/wt/test/a.test.ts", status: "passed", message: "", assertionResults: [{ status: "passed", failureMessages: [] }] }] };
    const parsed = parseRunnerJson("vitest", proc({ json, exitCode: 0 }));
    if (process.platform === "win32") expect(classifyFile(parsed, "c:\\tmp\\wt\\test\\a.test.ts").kind).toBe("passed");
    else expect(classifyFile(parsed, "C:/tmp/wt/test/a.test.ts").kind).toBe("passed");
  });
});
