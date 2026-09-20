import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyMutation, emptyRedGreen, type AnalysisReport } from "@merge-integrity/core";
import { parseInputs, resolveRefs } from "../../src/inputs.js";
import { renderSummary } from "../../src/summary.js";
import { escapeData, escapeProperty, formatAnnotation, stopCommands, writeOutputs } from "../../src/workflow.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mi-action-"));
  dirs.push(dir);
  return dir;
}

describe("workflow commands", () => {
  it("escapes data and properties so repository text cannot inject commands", () => {
    expect(escapeData("50%\r\n::set-output name=status::pass")).toBe("50%25%0D%0A::set-output name=status::pass");
    expect(escapeProperty("a,b:c\n")).toBe("a%2Cb%3Ac%0A");
    const line = formatAnnotation({ level: "error", file: "test/a,b.test.ts", line: 3, title: "MI001: x", message: "evil\n::warning::forged" });
    expect(line).toBe("::error file=test/a%2Cb.test.ts,line=3,title=MI001%3A x::evil%0A::warning::forged");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("writes outputs with random heredoc delimiters", () => {
    const file = join(tempDir(), "out");
    writeFileSync(file, "");
    writeOutputs(file, { status: "block", "blocker-count": "2" });
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^status<<ghadelimiter_[0-9a-f]{32}\nblock\nghadelimiter_[0-9a-f]{32}\nblocker-count<<ghadelimiter_[0-9a-f]{32}\n2\nghadelimiter_[0-9a-f]{32}\n$/);
    expect(() => writeOutputs(file, { "bad name": "x" })).toThrow();
  });

  it("uses unpredictable stop-commands tokens", () => {
    const a = stopCommands();
    const b = stopCommands();
    expect(a.stop).toMatch(/^::stop-commands::[0-9a-f]{48}$/);
    expect(a.resume).not.toBe(b.resume);
  });
});

describe("inputs and events", () => {
  const eventFile = (payload: unknown) => {
    const file = join(tempDir(), "event.json");
    writeFileSync(file, JSON.stringify(payload));
    return file;
  };
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);

  it("parses defaults and validates values", () => {
    expect(parseInputs({})).toEqual({
      mode: "check",
      workingDirectory: undefined,
      config: undefined,
      configSource: undefined,
      framework: undefined,
      mutation: undefined,
      redGreen: undefined,
      baseRef: undefined,
      headRef: undefined,
    });
    expect(parseInputs({ "INPUT_CONFIG-SOURCE": "head", INPUT_MUTATION: "false", INPUT_FRAMEWORK: "vitest" } as NodeJS.ProcessEnv)).toMatchObject({
      configSource: "head",
      mutation: false,
      framework: "vitest",
    });
    expect(() => parseInputs({ "INPUT_CONFIG-SOURCE": "pr" })).toThrow(/config-source/);
    expect(() => parseInputs({ INPUT_MUTATION: "yes" })).toThrow(/mutation/);
    expect(() => parseInputs({ INPUT_FRAMEWORK: "mocha" })).toThrow(/framework/);
    expect(parseInputs({ INPUT_MODE: "doctor" })).toMatchObject({ mode: "doctor" });
    expect(() => parseInputs({ INPUT_MODE: "off" })).toThrow(/mode/);
  });

  it("uses pull_request base SHA and the merge commit as head", () => {
    const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: eventFile({ pull_request: { base: { sha: BASE } } }) };
    expect(resolveRefs(env, parseInputs(env))).toEqual({ event: "pull_request", baseRef: BASE, headRef: HEAD });
  });

  it("supports merge_group", () => {
    const env = { GITHUB_EVENT_NAME: "merge_group", GITHUB_EVENT_PATH: eventFile({ merge_group: { base_sha: BASE, head_sha: HEAD } }) };
    expect(resolveRefs(env, parseInputs(env))).toEqual({ event: "merge_group", baseRef: BASE, headRef: HEAD });
  });

  it("refuses pull_request_target even with explicit refs", () => {
    const env = { GITHUB_EVENT_NAME: "pull_request_target", INPUT_BASE_REF: "main", "INPUT_BASE-REF": "main" };
    expect(() => resolveRefs(env, parseInputs(env))).toThrow(/pull_request_target/);
  });

  describe("PR-controlled inputs cannot weaken a protected run", () => {
    const prEnv = (inputs: Record<string, string>) => ({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: HEAD,
      GITHUB_EVENT_PATH: eventFile({ pull_request: { base: { sha: BASE } } }),
      ...inputs,
    });

    it.each([
      [{ "INPUT_BASE-REF": HEAD }, /base-ref/],
      [{ "INPUT_HEAD-REF": BASE }, /head-ref/],
      [{ "INPUT_BASE-REF": "main", "INPUT_HEAD-REF": "main" }, /base-ref/],
      [{ "INPUT_RED-GREEN": "false" }, /red-green/],
      [{ INPUT_MUTATION: "false" }, /mutation/],
      [{ "INPUT_CONFIG-SOURCE": "head" }, /config-source/],
      [{ "INPUT_WORKING-DIRECTORY": "docs" }, /working-directory/],
      [{ INPUT_CONFIG: "other.yml" }, /config/],
      [{ INPUT_FRAMEWORK: "vitest" }, /framework/],
      [{ INPUT_MODE: "doctor" }, /mode/],
    ])("rejects %o on pull_request", (inputs, pattern) => {
      const env = prEnv(inputs);
      expect(() => resolveRefs(env, parseInputs(env))).toThrow(pattern);
    });

    it("rejects weakening inputs on merge_group too", () => {
      const env = {
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: eventFile({ merge_group: { base_sha: BASE, head_sha: HEAD } }),
        "INPUT_RED-GREEN": "false",
      };
      expect(() => resolveRefs(env, parseInputs(env))).toThrow(/red-green/);
    });

    it("accepts defaults and strengthening inputs", () => {
      const env = prEnv({ "INPUT_CONFIG-SOURCE": "base", INPUT_MUTATION: "true", "INPUT_RED-GREEN": "true", INPUT_CONFIG: ".merge-integrity.yml", "INPUT_WORKING-DIRECTORY": "." });
      expect(resolveRefs(env, parseInputs(env))).toEqual({ event: "pull_request", baseRef: BASE, headRef: HEAD });
    });

    it("rejects an event whose base and head are identical", () => {
      const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: BASE, GITHUB_EVENT_PATH: eventFile({ pull_request: { base: { sha: BASE } } }) };
      expect(() => resolveRefs(env, parseInputs(env))).toThrow(/identical/);
    });

    it("still allows explicit refs outside protected events (manual runs)", () => {
      const env = { GITHUB_EVENT_NAME: "workflow_dispatch", "INPUT_BASE-REF": "main", "INPUT_HEAD-REF": "feature" };
      expect(resolveRefs(env, parseInputs(env))).toEqual({ event: "workflow_dispatch", baseRef: "main", headRef: "feature" });
    });
  });

  it("rejects unsupported events and malformed payloads", () => {
    const push = { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile({}) };
    expect(() => resolveRefs(push, parseInputs(push))).toThrow(/unsupported event/);
    const bad = { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: HEAD, GITHUB_EVENT_PATH: eventFile({ pull_request: { base: { sha: "$(id)" } } }) };
    expect(() => resolveRefs(bad, parseInputs(bad))).toThrow(/base.sha/);
  });
});

describe("step summary", () => {
  it("escapes repository-derived text and never renders ERROR as PASS", () => {
    const report: AnalysisReport = {
      schemaVersion: 1,
      status: "error",
      findings: [
        {
          ruleId: "MI001_TEST_SKIPPED",
          severity: "block",
          title: "Test skipped",
          file: "test/<img src=x onerror=alert(1)>.test.ts",
          startLine: 1,
          message: 'test "| injected | table |" is skipped <script>alert(1)</script> @everyone',
        },
      ],
      ignoredFindings: [],
      redGreen: emptyRedGreen("error", "boom"),
      mutation: emptyMutation("skipped"),
      durationMs: 10,
      timings: {},
      notes: [],
      error: { code: "X", stage: "git", message: "base revision history is unavailable" },
    };
    const md = renderSummary(report);
    expect(md).toContain("## Merge Integrity: ERROR");
    expect(md).toContain("No merge decision was made.");
    expect(md).not.toContain("PASS");
    expect(md).not.toMatch(/<img|<script/);
    expect(md).not.toContain("@everyone");
    const row = md.split("\n").find((l) => l.startsWith("| BLOCK"));
    expect(row?.split(/(?<!\\)\|/).length).toBe(6);
  });

  it("presents inconclusive verification (MI103, MI107) as advisory WARN findings for review, never as PASS or as a failure", () => {
    const report: AnalysisReport = {
      schemaVersion: 1,
      status: "warn",
      findings: [
        {
          ruleId: "MI103_RED_GREEN_INCONCLUSIVE",
          severity: "warn",
          title: "Red/green verification inconclusive",
          file: "test/a.test.ts",
          message: "inconclusive",
        },
        {
          ruleId: "MI107_TEST_DISCOVERY_UNSUPPORTED",
          severity: "warn",
          title: "Test discovery could not be fully analysed",
          file: "jest.config.js",
          message: "Custom test discovery could not be analysed",
        },
      ],
      ignoredFindings: [],
      redGreen: emptyRedGreen("completed"),
      mutation: emptyMutation("disabled"),
      durationMs: 10,
      timings: {},
      notes: [],
    };
    const md = renderSummary(report);
    expect(md).toContain("## Merge Integrity: WARN");
    expect(md).toContain("0 blockers · 2 warnings");
    expect(md).toContain("Warnings are advisory evidence for a reviewer");
    expect(md).toContain("| WARN | `MI103_RED_GREEN_INCONCLUSIVE` |");
    expect(md).toContain("| WARN | `MI107_TEST_DISCOVERY_UNSUPPORTED` |");
    expect(md).not.toContain("PASS");
    expect(md).not.toMatch(/check failed/i);
  });
});
