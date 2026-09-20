import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck, type CheckOptions, type VerificationStages } from "../../src/check/run-check.js";
import { verifyRedGreen } from "../../src/red-green/verifier.js";
import { runMutationStage } from "../../src/mutation/stage.js";
import { createRepo, TEST_REPOS, type TempRepo } from "../../../../test-support/repo.js";

const repos: TempRepo[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
  while (cleanups.length) cleanups.pop()?.();
});

const JEST_SRC = (cond: string) =>
  `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  return ${cond};\n}\n\nmodule.exports = { add, isAdult };\n`;
const VITEST_SRC = (cond: string) =>
  `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function isAdult(age: number): boolean {\n  return ${cond};\n}\n`;
const jestTests = (body: string) => `const fs = require("fs");\nconst os = require("os");\nconst path = require("path");\nconst { add, isAdult } = require("../src/math");\n\ndescribe("math", () => {\n${body}\n});\n`;
const vitestTests = (body: string) =>
  `import { describe, expect, it } from "vitest";\nimport { add, isAdult } from "../src/math";\n\ndescribe("math", () => {\n${body}\n});\n`;

function jestRepo(baseTests: string): TempRepo {
  const repo = createRepo({ fixture: "jest-basic" });
  repos.push(repo);
  repo.write({ "src/math.js": JEST_SRC("age > 18"), "test/math.test.js": jestTests(baseTests) });
  repo.commit("buggy base");
  repo.git("checkout", "-q", "-b", "pr");
  return repo;
}

async function check(repo: TempRepo, extra: Partial<CheckOptions> = {}, stages?: VerificationStages) {
  return (await runCheck({ cwd: repo.dir, baseRef: "main", headRef: "HEAD", configSource: "base", ...extra }, stages)).report;
}

const ADDS = `  it("adds", () => {\n    expect(add(2, 3)).toBe(5);\n  });`;

describe("red/green: one discriminating test cannot mask another (per-test verification)", () => {
  it("BLOCKs the non-discriminating test even when another changed test in the same file is RED (Jest)", async () => {
    const repo = jestRepo(ADDS);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `${ADDS}\n  it("treats 18 as adult", () => {\n    expect(isAdult(18)).toBe(true);\n  });\n  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });`,
      ),
    });
    repo.commit("one real and one fake regression test");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn"); // MI006 is advisory by default
    const mi006 = report.findings.filter((f) => f.ruleId === "MI006_REGRESSION_TEST_NON_DISCRIMINATING");
    expect(mi006).toHaveLength(1);
    expect(mi006[0]?.message).toContain("treats 40 as adult");
    expect(report.redGreen).toMatchObject({ verifiedTests: 1, nonDiscriminatingTests: 1 });
  });

  it("BLOCKs the non-discriminating test in Vitest as well", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    repo.write({ "src/math.ts": VITEST_SRC("age > 18"), "test/math.test.ts": vitestTests(ADDS) });
    repo.commit("buggy base");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      "src/math.ts": VITEST_SRC("age >= 18"),
      "test/math.test.ts": vitestTests(
        `${ADDS}\n  describe("boundaries", () => {\n    it("treats 18 as adult", () => {\n      expect(isAdult(18)).toBe(true);\n    });\n    it("treats 40 as adult", () => {\n      expect(isAdult(40)).toBe(true);\n    });\n  });`,
      ),
    });
    repo.commit("one real and one fake regression test");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn"); // MI006 is advisory by default
    const mi006 = report.findings.filter((f) => f.ruleId === "MI006_REGRESSION_TEST_NON_DISCRIMINATING");
    expect(mi006.map((f) => f.message).join("\n")).toContain("treats 40 as adult");
    expect(mi006.map((f) => f.message).join("\n")).not.toContain("treats 18 as adult");
  });

  it("does not require unchanged tests in the file to discriminate", async () => {
    const repo = jestRepo(`${ADDS}\n  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });`);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `${ADDS}\n  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });\n  it("treats 18 as adult", () => {\n    expect(isAdult(18)).toBe(true);\n  });`,
      ),
    });
    repo.commit("add a real regression test next to unchanged tests");
    const report = await check(repo, { mutation: false });
    expect(report.error).toBeUndefined();
    expect(report.status).toBe("pass");
    expect(report.redGreen).toMatchObject({ verifiedTests: 1, nonDiscriminatingTests: 0 });
  });

  it("reports tests whose runtime names cannot be matched (test.each) as inconclusive, never verified", async () => {
    const repo = jestRepo(ADDS);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(`${ADDS}\n  it.each([[18], [19]])("treats %i as adult", (age) => {\n    expect(isAdult(age)).toBe(true);\n  });`),
    });
    repo.commit("table test");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn");
    expect(report.findings.map((f) => f.ruleId)).toEqual(["MI103_RED_GREEN_INCONCLUSIVE"]);
    expect(report.redGreen.verifiedTests).toBe(0);
  });
});

describe("red/green: test discovery cannot be widened by the pull request", () => {
  it("does not let a PR-added testMatch reclassify production source as tests to skip verification", async () => {
    const repo = jestRepo(ADDS);
    repo.write({
      "jest.config.js": 'module.exports = { testMatch: ["**/test/**/*.test.js", "**/src/**/*.js"] };\n',
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(`${ADDS}\n  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });`),
    });
    repo.commit("fake fix with widened discovery");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn"); // MI006 is advisory by default
    expect(report.findings.map((f) => f.ruleId)).toContain("MI006_REGRESSION_TEST_NON_DISCRIMINATING");
    expect(report.findings.map((f) => f.ruleId)).toContain("MI105_COVERAGE_SCOPE_REDUCED");
  });
});

describe("red/green: runs are isolated from each other's state", () => {
  it("state written into the worktree by the original base run cannot fake RED for the overlay run", async () => {
    const baseTests = `  it("adds", () => {\n    fs.writeFileSync("state-marker", "x");\n    expect(add(2, 3)).toBe(5);\n  });`;
    const repo = jestRepo(baseTests);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `  it("treats 40 as adult", () => {\n    expect(fs.existsSync("state-marker")).toBe(false);\n    expect(isAdult(40)).toBe(true);\n  });\n${baseTests}`,
      ),
    });
    repo.commit("test relies on leftover state");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn"); // MI006 is advisory by default
    expect(report.findings.map((f) => f.ruleId)).toEqual(["MI006_REGRESSION_TEST_NON_DISCRIMINATING"]);
  });

  it("state written to the temporary directory by the head run cannot fake RED on the base", async () => {
    const marker = `mi-cross-run-${randomUUID()}`;
    cleanups.push(() => rmSync(join(tmpdir(), marker), { force: true }));
    const repo = jestRepo(ADDS);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `${ADDS}\n  it("treats 40 as adult", () => {\n    const marker = path.join(os.tmpdir(), ${JSON.stringify(marker)});\n    const seen = fs.existsSync(marker);\n    fs.writeFileSync(marker, "x");\n    expect(seen).toBe(false);\n    expect(isAdult(40)).toBe(true);\n  });`,
      ),
    });
    repo.commit("test relies on temp-dir state");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("warn"); // MI006 is advisory by default
    expect(report.findings.map((f) => f.ruleId)).toEqual(["MI006_REGRESSION_TEST_NON_DISCRIMINATING"]);
  });

  it("returns ERROR when a test modifies the shared installed dependencies", async () => {
    // Top-level additions land in the disposable per-worktree node_modules; writing inside an installed package
    // reaches the shared install and must be detected.
    const poison = `mi-poison-${randomUUID()}.txt`;
    const poisonPath = join(TEST_REPOS, "jest-basic", "node_modules", "jest", poison);
    cleanups.push(() => rmSync(poisonPath, { force: true }));
    const repo = jestRepo(ADDS);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `${ADDS}\n  it("treats 18 as adult", () => {\n    fs.writeFileSync(path.join("node_modules", "jest", ${JSON.stringify(poison)}), "poison");\n    expect(isAdult(18)).toBe(true);\n  });`,
      ),
    });
    repo.commit("test writes into node_modules");
    const report = await check(repo, { mutation: false });
    expect(report.status).toBe("error");
    expect(report.error?.message).toMatch(/dependenc/i);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("merge-integrity-"))).toEqual(expect.any(Array));
  });

  it("mutation testing runs in a fresh worktree, not one modified by earlier test runs", async () => {
    const repo = jestRepo(ADDS);
    repo.write({
      "src/math.js": JEST_SRC("age >= 18"),
      "test/math.test.js": jestTests(
        `${ADDS}\n  it("treats 18 as adult", () => {\n    fs.writeFileSync("head-run-marker", "x");\n    expect(isAdult(18)).toBe(true);\n  });`,
      ),
    });
    repo.commit("fix");
    let markerSeenByMutation: boolean | undefined;
    const stages: VerificationStages = {
      redGreen: (ctx) => verifyRedGreen(ctx, { workspace: ctx.workspace }),
      mutation: (ctx) =>
        runMutationStage(ctx, {
          run: async (args) => {
            markerSeenByMutation = existsSync(join(args.projectDir, "head-run-marker"));
            return { candidates: 0, sampled: false, mutants: [] };
          },
        }),
    };
    await check(repo, { mutation: true }, stages);
    expect(markerSeenByMutation).toBe(false);
  });
});
