import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultStages, runCheck, type CheckOptions, type VerificationStages } from "../../src/check/run-check.js";
import { liveWorkspaceCount } from "../../src/red-green/worktree.js";
import { createRepo, TEST_REPOS, type TempRepo } from "../../../../test-support/repo.js";

type Fw = "jest" | "vitest" | "vitest5";

const FW = {
  jest: {
    ext: "js",
    src: (isAdult: string, extra = "") =>
      `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  ${isAdult}\n}\n${extra}\nmodule.exports = { add, isAdult${extra.includes("function subtract") ? ", subtract" : ""} };\n`,
    header: (names: string[]) => `const { ${names.join(", ")} } = require("../src/math");\n`,
  },
  vitest: {
    ext: "ts",
    src: (isAdult: string, extra = "") =>
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function isAdult(age: number): boolean {\n  ${isAdult}\n}\n${extra.replace("function subtract", "export function subtract")}\n`,
    header: (names: string[]) => `import { describe, expect, it } from "vitest";\nimport { ${names.join(", ")} } from "../src/math";\n`,
  },
} as const;
const FWS = { ...FW, vitest5: FW.vitest };

const repos: TempRepo[] = [];
let tempBefore: Set<string>;

function tempEntries(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("merge-integrity-")));
}

beforeEach(() => {
  tempBefore = tempEntries();
});

afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
});

function setup(fw: Fw, baseIsAdult: string): TempRepo {
  const repo = createRepo({ fixture: `${fw}-basic` });
  repos.push(repo);
  repo.write({
    [`src/math.${FWS[fw].ext}`]: FWS[fw].src(baseIsAdult),
    // A green base suite: the pre-existing test does not exercise the boundary.
    [`test/math.test.${FWS[fw].ext}`]: testFile(fw, `  it("adds", () => { expect(add(2, 3)).toBe(5); });`),
  });
  repo.commit("base implementation");
  repo.git("checkout", "-q", "-b", "pr");
  return repo;
}

function testFile(fw: Fw, body: string, names = ["add", "isAdult"]): string {
  return `${FWS[fw].header(names)}\ndescribe("math", () => {\n${body}\n});\n`;
}

async function check(repo: TempRepo, extra: Partial<CheckOptions> = {}, stages?: VerificationStages) {
  const outcome = await runCheck({ cwd: repo.dir, baseRef: "main", headRef: "HEAD", configSource: "base", mutation: false, ...extra }, stages);
  return outcome.report;
}

function expectCleanedUp(repo: TempRepo, fw: Fw): void {
  const leftovers = [...tempEntries()].filter((n) => !tempBefore.has(n));
  expect(leftovers).toEqual([]);
  expect(liveWorkspaceCount()).toBe(0);
  const worktrees = repo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
  expect(worktrees).toHaveLength(1);
  // The real dependencies behind the worktree links must survive cleanup.
  expect(existsSync(join(TEST_REPOS, `${fw}-basic`, "node_modules", fw === "jest" ? "jest" : "vitest", "package.json"))).toBe(true);
}

const BUGGY = "return age > 18;";
const FIXED = "return age >= 18;";

describe.each(["jest", "vitest", "vitest5"] as const)("red/green with %s", (fw) => {
  const ext = FWS[fw].ext;
  const TEST = `test/math.test.${ext}`;
  const SRC = `src/math.${ext}`;

  it("verifies a real regression test (fails on base, passes on head) and PASSes", async () => {
    const repo = setup(fw, BUGGY);
    repo.write({
      [SRC]: FWS[fw].src(FIXED),
      [TEST]: testFile(fw, `  it("adds", () => { expect(add(2, 3)).toBe(5); });\n  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("fix boundary");
    const report = await check(repo);
    expect(report.error).toBeUndefined();
    expect(report.redGreen).toMatchObject({ status: "completed", verifiedFiles: 1, nonDiscriminatingFiles: 0, inconclusiveFiles: 0 });
    expect(report.redGreen.files[0]).toMatchObject({ file: TEST, outcome: "verified", head: "passed", baseOriginal: "passed", baseOverlay: "assertion-failure" });
    expect(report.status).toBe("pass");
    expectCleanedUp(repo, fw);
  });

  it("does not judge unchanged duplicate-named or runtime-named tests when a regression test is added (calibration D1)", async () => {
    // Mirrors harrisiirak/cron-parser#445/#450: the file already has two tests with the same name and a loop of
    // runtime-named tests; the PR only adds a regression test next to them.
    const existing = [
      `  it("adds", () => { expect(add(2, 3)).toBe(5); });`,
      `  it("adds", () => { expect(add(1, 1)).toBe(2); });`,
      `  for (const n of [1, 2]) {\n    it(\`adds zero to \${n}\`, () => { expect(add(n, 0)).toBe(n); });\n  }`,
    ].join("\n");
    const repo = createRepo({ fixture: `${fw}-basic` });
    repos.push(repo);
    repo.write({ [SRC]: FWS[fw].src(BUGGY), [TEST]: testFile(fw, existing) });
    repo.commit("base with duplicate and runtime-named tests");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      [SRC]: FWS[fw].src(FIXED),
      [TEST]: testFile(fw, `${existing}\n  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("fix boundary");
    const report = await check(repo);
    expect(report.error).toBeUndefined();
    expect(report.findings).toEqual([]);
    expect(report.redGreen).toMatchObject({ status: "completed", verifiedTests: 1, nonDiscriminatingTests: 0, inconclusiveTests: 0 });
    expect(report.status).toBe("pass");
    expectCleanedUp(repo, fw);
  });

  it("reports a fake regression test that passes on base and head as advisory MI006 (WARN)", async () => {
    const repo = setup(fw, BUGGY);
    repo.write({
      [SRC]: FWS[fw].src(FIXED),
      [TEST]: testFile(fw, `  it("adds", () => { expect(add(2, 3)).toBe(5); });\n  it("treats 30 as adult", () => { expect(isAdult(30)).toBe(true); });`),
    });
    repo.commit("fix boundary with a test that does not exercise it");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.findings.map((f) => [f.ruleId, f.severity])).toEqual([["MI006_REGRESSION_TEST_NON_DISCRIMINATING", "warn"]]);
    expect(report.redGreen.files[0]).toMatchObject({ outcome: "non-discriminating", baseOverlay: "passed" });
    expectCleanedUp(repo, fw);
  });

  it("does not count a missing base API as RED (MI103 WARN)", async () => {
    const repo = setup(fw, FIXED);
    repo.write({
      [SRC]: FWS[fw].src(FIXED, "function subtract(a, b) {\n  return a - b;\n}\n".replace("(a, b)", fw === "jest" ? "(a, b)" : "(a: number, b: number): number")),
      [`test/subtract.test.${ext}`]: testFile(fw, `  it("subtracts", () => { expect(subtract(5, 3)).toBe(2); });`, ["subtract"]),
    });
    repo.commit("add subtract");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.findings.map((f) => f.ruleId)).toEqual(["MI103_RED_GREEN_INCONCLUSIVE"]);
    expect(report.redGreen.files[0]?.outcome).toBe("inconclusive");
    expect(report.redGreen.files[0]?.baseOverlay).toBe("runtime-error");
    expectCleanedUp(repo, fw);
  });

  it("does not count a missing base module (import failure) as RED (MI103 WARN)", async () => {
    const repo = setup(fw, FIXED);
    const helper = fw === "jest" ? "module.exports = { double: (x) => x * 2 };\n" : "export const double = (x: number): number => x * 2;\n";
    const header = fw === "jest" ? `const { double } = require("../src/double");\n` : `import { describe, expect, it } from "vitest";\nimport { double } from "../src/double";\n`;
    repo.write({
      [`src/double.${ext}`]: helper,
      [`test/double.test.${ext}`]: `${header}describe("double", () => { it("doubles", () => { expect(double(2)).toBe(4); }); });\n`,
    });
    repo.commit("add module");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.redGreen.files[0]).toMatchObject({ outcome: "inconclusive", baseOverlay: "setup-error" });
    expectCleanedUp(repo, fw);
  });

  it("returns ERROR (never PASS) when the changed test fails on head", async () => {
    const repo = setup(fw, BUGGY);
    repo.write({
      [SRC]: FWS[fw].src("return age >= 21;"),
      [TEST]: testFile(fw, `  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("broken fix");
    const report = await check(repo);
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("RED_GREEN_FAILED");
    expect(report.error?.message).toContain("does not pass on the PR head");
    expectCleanedUp(repo, fw);
  });
});

describe("red/green edge cases (jest)", () => {
  const fw: Fw = "jest";
  const TEST = "test/math.test.js";
  const SRC = "src/math.js";

  it("marks base tests that were already failing as inconclusive", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      [SRC]: FW.jest.src(BUGGY),
      [TEST]: testFile(fw, `  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("base with a failing test");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      [SRC]: FW.jest.src(FIXED),
      [TEST]: testFile(fw, `  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`),
    });
    repo.commit("fix");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.redGreen.files[0]).toMatchObject({ outcome: "inconclusive", baseOriginal: "assertion-failure" });
  });

  it("returns ERROR when base execution exceeds the time budget, and still cleans up", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      ".merge-integrity.yml": "version: 1\nredGreen:\n  timeoutSeconds: 25\n",
      [SRC]: FW.jest.src("for (;;) {}"),
    });
    repo.commit("base hangs");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      [SRC]: FW.jest.src(FIXED),
      [TEST]: testFile(fw, `  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("fix hang");
    const started = Date.now();
    const report = await check(repo);
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("RED_GREEN_FAILED");
    expect(report.error?.message).toMatch(/timed out|time budget/);
    expectCleanedUp(repo, fw);
  });

  it("cleans up worktrees when a stage throws", async () => {
    const repo = setup(fw, BUGGY);
    repo.write({ [SRC]: FW.jest.src(FIXED), [TEST]: testFile(fw, `  it("x", () => { expect(isAdult(18)).toBe(true); });`) });
    repo.commit("fix");
    let created: string | undefined;
    const report = await check(repo, {}, {
      redGreen: async (ctx) => {
        const wt = await ctx.workspace.freshWorktree("base", ctx.mergeBase);
        created = wt.root;
        throw new Error("simulated verifier crash");
      },
    });
    expect(report.status).toBe("error");
    expect(created).toBeDefined();
    expect(existsSync(created as string)).toBe(false);
    expectCleanedUp(repo, fw);
  });

  it("downgrades a non-discriminating result to MI103 when dependency manifests changed", async () => {
    const repo = setup(fw, BUGGY);
    const manifest = JSON.parse(repo.git("show", "HEAD:package.json"));
    manifest.dependencies = { "left-pad": "1.3.0" };
    repo.write({
      "package.json": JSON.stringify(manifest, null, 2),
      [SRC]: FW.jest.src(FIXED),
      [TEST]: testFile(fw, `  it("treats 30 as adult", () => { expect(isAdult(30)).toBe(true); });`),
    });
    repo.commit("dependency bump fix");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.findings.map((f) => f.ruleId)).toEqual(["MI103_RED_GREEN_INCONCLUSIVE"]);
  });

  it("reports a changed test that the runner does not collect as inconclusive, not PASS", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({ "jest.config.js": 'module.exports = { testPathIgnorePatterns: ["/node_modules/", "/e2e/"] };\n', [SRC]: FW.jest.src(BUGGY) });
    repo.commit("config");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({ [SRC]: FW.jest.src(FIXED), "e2e/math.test.js": testFile(fw, `  it("x", () => { expect(isAdult(18)).toBe(true); });`).replace("../src/math", "../src/math") });
    repo.commit("e2e");
    const report = await check(repo);
    expect(report.status).toBe("warn");
    expect(report.redGreen.files[0]).toMatchObject({ outcome: "inconclusive", head: "not-collected" });
  });

  it("handles shell metacharacters in test file names and test names during execution", async () => {
    const repo = setup(fw, BUGGY);
    const evil = "test/$(touch pwned) & `whoami` ; b.test.js";
    repo.write({
      [SRC]: FW.jest.src(FIXED),
      [evil]: testFile(fw, `  it("$(touch pwned2); rm -rf / && \`id\`", () => { expect(isAdult(18)).toBe(true); });`),
    });
    repo.commit("evil names");
    const report = await check(repo);
    expect(report.status).toBe("pass");
    expect(report.redGreen.files[0]).toMatchObject({ file: evil, outcome: "verified" });
    for (const dir of [repo.dir, join(repo.dir, "test"), process.cwd()]) {
      expect(readdirSync(dir).filter((n) => n.startsWith("pwned"))).toEqual([]);
    }
  });

  it("does not expose Actions tokens or step files to repository tests", async () => {
    const repo = setup(fw, BUGGY);
    const outputFile = join(mkdtempSync(join(tmpdir(), "mi-output-")), "github_output");
    writeFileSync(outputFile, "");
    repo.write({
      [SRC]: FW.jest.src(FIXED),
      [TEST]: testFile(
        fw,
        `  it("treats 18 as adult without leaking secrets", () => {\n    const leaked = ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_OUTPUT", "INPUT_CONFIG"].filter((k) => process.env[k] !== undefined);\n    if (leaked.length > 0) { require("fs").appendFileSync(${JSON.stringify(outputFile)}, "status=pass\\n"); throw new Error("leaked " + leaked.join()); }\n    expect(isAdult(18)).toBe(true);\n  });`,
      ),
    });
    repo.commit("fix");
    const saved = { ...process.env };
    Object.assign(process.env, {
      GITHUB_TOKEN: "ghs_fake",
      ACTIONS_RUNTIME_TOKEN: "rt_fake",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "id_fake",
      GITHUB_OUTPUT: outputFile,
      INPUT_CONFIG: "x",
    });
    try {
      const report = await check(repo);
      expect(report.status).toBe("pass");
      expect(report.redGreen.verifiedFiles).toBe(1);
    } finally {
      for (const key of ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_OUTPUT", "INPUT_CONFIG"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    expect(readFileSync(outputFile, "utf8")).toBe("");
    rmSync(join(outputFile, ".."), { recursive: true, force: true });
  });

  it("does not follow links created by repository tests when cleaning up", async () => {
    const repo = setup(fw, BUGGY);
    const outside = mkdtempSync(join(tmpdir(), "mi-outside-"));
    writeFileSync(join(outside, "sentinel.txt"), "keep me");
    repo.write({
      [SRC]: FW.jest.src(FIXED),
      [TEST]: testFile(
        fw,
        `  it("treats 18 as adult", () => {\n    const fs = require("fs");\n    try { fs.symlinkSync(${JSON.stringify(outside)}, "escape-link", process.platform === "win32" ? "junction" : "dir"); } catch {}\n    expect(isAdult(18)).toBe(true);\n  });`,
      ),
    });
    repo.commit("test creates a link");
    const report = await check(repo);
    expect(report.status).toBe("pass");
    expect(existsSync(join(outside, "sentinel.txt"))).toBe(true);
    expectCleanedUp(repo, fw);
    rmSync(outside, { recursive: true, force: true });
  });

  it("uses the real verifier by default", () => {
    expect(defaultStages().redGreen).toBeTypeOf("function");
  });
});
