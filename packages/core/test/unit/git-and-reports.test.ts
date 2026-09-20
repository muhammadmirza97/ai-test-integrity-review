import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfigText } from "../../src/config/parse.js";
import { emptyMutation, emptyRedGreen, type AnalysisReport } from "../../src/domain/result.js";
import { isSafeRelativePath, resolveContainedPath, UnsafePathError } from "../../src/fs/paths.js";
import { classifyPath, isImplementationClass } from "../../src/git/classify.js";
import { isAcceptableRef, parseAddedRanges, parseNameStatusZ } from "../../src/git/repository.js";
import { comparePolicies, policyWeakenings } from "../../src/rules/policy-weakened.js";
import { markdownText, terminalText } from "../../src/report/sanitize.js";
import { renderText } from "../../src/report/text.js";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("git output parsing", () => {
  it("parses NUL-separated name-status output including renames and odd names", () => {
    const out = ["M", "src/a b.ts", "R087", "test/old.test.ts", "test/new;$(x).test.ts", "D", "docs/\nnewline.md", "A", "x"].join("\0") + "\0";
    expect(parseNameStatusZ(out)).toEqual([
      { status: "modified", path: "src/a b.ts" },
      { status: "renamed", path: "test/new;$(x).test.ts", oldPath: "test/old.test.ts" },
      { status: "deleted", path: "docs/\nnewline.md" },
      { status: "added", path: "x" },
    ]);
  });

  it("rejects traversal or absolute paths in diff output", () => {
    expect(() => parseNameStatusZ("M\0../../etc/passwd\0")).toThrow(/unsafe path/);
    expect(() => parseNameStatusZ("M\0/etc/passwd\0")).toThrow(/unsafe path/);
    expect(() => parseNameStatusZ("X\0a\0")).toThrow(/unexpected/);
    expect(() => parseNameStatusZ("R100\0a\0")).toThrow(/truncated/);
  });

  it("parses added line ranges from zero-context hunks", () => {
    const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -10,0 +11,3 @@\n+c\n+d\n+e\n@@ -20,2 +23,0 @@\n-f\n-g\n";
    expect(parseAddedRanges(diff)).toEqual([
      { start: 1, end: 1 },
      { start: 11, end: 13 },
    ]);
  });

  it("rejects option-like and control-character refs", () => {
    expect(isAcceptableRef("main")).toBe(true);
    expect(isAcceptableRef("origin/feature-1")).toBe(true);
    expect(isAcceptableRef("--upload-pack=touch x")).toBe(false);
    expect(isAcceptableRef("main\nHEAD")).toBe(false);
    expect(isAcceptableRef("")).toBe(false);
  });
});

describe("path safety", () => {
  it("accepts only contained relative paths", () => {
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
    for (const bad of ["../a", "a/../../b", "/etc/passwd", "C:/x", "a\\b", "a\0b", ""]) expect(isSafeRelativePath(bad), bad).toBe(false);
  });

  it("refuses to resolve through symlinked directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "mi-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "mi-outside-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
      await expect(resolveContainedPath(root, "real/file.txt")).resolves.toContain("real");
      await expect(resolveContainedPath(root, "link/file.txt")).rejects.toThrow(UnsafePathError);
      await expect(resolveContainedPath(root, "../escape.txt")).rejects.toThrow(UnsafePathError);
    } finally {
      rmSync(join(root, "link"), { force: true, recursive: false });
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("classifyPath", () => {
  it.each([
    ["src/auth.test.ts", "test"],
    ["src/__tests__/auth.ts", "test"],
    ["test/math.spec.jsx", "test"],
    ["test/helpers.ts", "test-support"],
    ["src/__mocks__/db.ts", "test-support"],
    ["src/__snapshots__/a.test.ts.snap", "snapshot"],
    ["jest.config.js", "test-config"],
    ["vitest.config.mts", "test-config"],
    ["package.json", "package-manifest"],
    ["pnpm-lock.yaml", "lockfile"],
    ["README.md", "docs"],
    ["src/auth.ts", "source"],
    ["src/types.d.ts", "other"],
    ["src/data.json", "other"],
    ["packages/x/package.json", "other"],
  ])("%s -> %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it("treats docs and tests as non-implementation", () => {
    expect(isImplementationClass("docs")).toBe(false);
    expect(isImplementationClass("test")).toBe(false);
    expect(isImplementationClass("source")).toBe(true);
  });
});

describe("sanitisation", () => {
  it("removes terminal control and bidi characters", () => {
    const out = terminalText("a\u001b[31mred\u0007\nnext\u202Eevil");
    for (const code of [0x1b, 0x07, 0x0a, 0x202e]) expect(out).not.toContain(String.fromCharCode(code));
  });

  it("escapes markdown and HTML", () => {
    expect(markdownText("<img src=x onerror=alert(1)> **bold** @team [link](http://x)")).not.toMatch(/<img|\*\*bold\*\*|\[link\]\(/);
    expect(markdownText("@octocat")).not.toBe("@octocat");
  });
});

describe("policy weakening", () => {
  const parse = (text: string) => {
    const r = parseConfigText(text, "t");
    if (!r.ok) throw new Error(r.errors.join());
    return r.config;
  };

  it("detects lowered severities, disabled stages, new ignores and moved working directories", () => {
    const head = parse(
      "version: 1\nworkingDirectory: other\nredGreen:\n  enabled: false\nmutation:\n  maxMutants: 1\nrules:\n  MI004_ASSERTION_WEAKENED: warn\nignore:\n  - rule: MI001_TEST_SKIPPED\n    path: src/**\n    reason: x\n",
    );
    const reasons = policyWeakenings(DEFAULT_CONFIG, head);
    expect(reasons.join("\n")).toMatch(/MI004.*warn/);
    expect(reasons.join("\n")).toMatch(/red\/green verification disabled/);
    expect(reasons.join("\n")).toMatch(/maxMutants/);
    expect(reasons.join("\n")).toMatch(/ignore entries added/);
    expect(reasons.join("\n")).toMatch(/workingDirectory/);
  });

  it("does not flag a stricter policy", () => {
    const head = parse("version: 1\npolicy:\n  warningsBlockMerge: true\nrules:\n  MI102_MUTATION_SURVIVED: block\nmutation:\n  maxMutants: 50\n");
    expect(comparePolicies(".merge-integrity.yml", DEFAULT_CONFIG, head, "base")).toEqual([]);
  });

  it("flags an invalid proposed config when base policy is applied", () => {
    expect(comparePolicies(".merge-integrity.yml", DEFAULT_CONFIG, "invalid", "base")).toHaveLength(1);
  });
});

describe("text report", () => {
  const base: AnalysisReport = {
    schemaVersion: 1,
    status: "pass",
    findings: [],
    ignoredFindings: [],
    redGreen: { ...emptyRedGreen("completed"), verifiedFiles: 3, verifiedTests: 4, files: [1, 2, 3].map((n) => ({ file: `t${n}.test.ts`, outcome: "verified" as const, reason: "", tests: [] })) },
    mutation: { ...emptyMutation("completed"), attempted: 8, killed: 8, candidates: 8 },
    durationMs: 1200,
    timings: {},
    notes: [],
  };

  it("keeps a PASS nearly silent", () => {
    expect(renderText(base)).toMatch(/^Merge Integrity: PASS\n0 blockers · 0 warnings\n\nRed\/green: 4 changed tests verified \(3 files\)\nMutation: 8\/8 relevant mutants killed\n/);
  });

  it("never renders ERROR as PASS", () => {
    const text = renderText({ ...base, status: "error", error: { code: "X", stage: "git", message: "base revision history is unavailable" } });
    expect(text).toMatch(/^Merge Integrity: ERROR/);
    expect(text).toContain("No merge decision was made.");
    expect(text).not.toContain("PASS");
  });
});
