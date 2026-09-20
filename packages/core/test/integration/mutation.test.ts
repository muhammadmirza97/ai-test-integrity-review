import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck, type CheckOptions } from "../../src/check/run-check.js";
import { createRepo, type TempRepo } from "../../../../test-support/repo.js";

type Fw = "jest" | "vitest";

const SRC = {
  jest: (body: string) => `function isAdult(age) {\n  ${body}\n}\n\nmodule.exports = { isAdult };\n`,
  vitest: (body: string) => `export function isAdult(age: number): boolean {\n  ${body}\n}\n`,
};
/** A base test kept unchanged in every revision (it passes on the inverted base and on the fix). */
const KEEP = `  it("returns a boolean", () => { expect(typeof isAdult(40)).toBe("boolean"); });`;
const TEST = {
  jest: (body: string) => `const { isAdult } = require("../src/age");\n\ndescribe("isAdult", () => {\n${KEEP}\n${body}\n});\n`,
  vitest: (body: string) => `import { describe, expect, it } from "vitest";\nimport { isAdult } from "../src/age";\n\ndescribe("isAdult", () => {\n${KEEP}\n${body}\n});\n`,
};
const ext = (fw: Fw) => (fw === "jest" ? "js" : "ts");

const repos: TempRepo[] = [];
let tempBefore: Set<string>;
const temps = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("merge-integrity-")));
beforeEach(() => {
  tempBefore = temps();
});
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
  expect([...temps()].filter((n) => !tempBefore.has(n))).toEqual([]);
});

function setup(fw: Fw, config?: string): TempRepo {
  const repo = createRepo({ fixture: `${fw}-basic` });
  repos.push(repo);
  repo.write({
    [`src/age.${ext(fw)}`]: SRC[fw]("return age < 18;"),
    [`test/age.test.${ext(fw)}`]: TEST[fw](""),
    ...(config ? { ".merge-integrity.yml": config } : {}),
  });
  repo.commit("base");
  repo.git("checkout", "-q", "-b", "pr");
  return repo;
}

async function check(repo: TempRepo, extra: Partial<CheckOptions> = {}) {
  return (await runCheck({ cwd: repo.dir, baseRef: "main", headRef: "HEAD", configSource: "base", mutation: true, ...extra })).report;
}

describe.each(["jest", "vitest"] as const)("targeted mutation testing with %s", (fw) => {
  it("PASSes when strong tests kill every mutant on the changed line", async () => {
    const repo = setup(fw);
    repo.write({
      [`src/age.${ext(fw)}`]: SRC[fw]("return age >= 18;"),
      [`test/age.test.${ext(fw)}`]: TEST[fw](
        `  it("treats 40 as adult", () => { expect(isAdult(40)).toBe(true); });\n  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`,
      ),
    });
    repo.commit("fix boundary with strong tests");
    const report = await check(repo);
    expect(report.error).toBeUndefined();
    expect(report.redGreen.verifiedFiles).toBe(1);
    expect(report.mutation.status).toBe("completed");
    expect(report.mutation.attempted).toBeGreaterThan(0);
    expect(report.mutation.survived + report.mutation.noCoverage).toBe(0);
    expect(report.mutation.killed + report.mutation.timedOut).toBe(report.mutation.attempted);
    expect(report.status).toBe("pass");
  });

  it("WARNs (MI102) when a weak test lets a mutant survive", async () => {
    const repo = setup(fw);
    repo.write({
      [`src/age.${ext(fw)}`]: SRC[fw]("return age >= 18;"),
      [`test/age.test.${ext(fw)}`]: TEST[fw](
        `  it("treats 40 as adult", () => { expect(isAdult(40)).toBe(true); });\n  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });`,
      ),
    });
    repo.commit("fix boundary with a weak test");
    const report = await check(repo);
    expect(report.error).toBeUndefined();
    expect(report.redGreen.verifiedFiles).toBe(1);
    expect(report.status).toBe("warn");
    const survivors = report.findings.filter((f) => f.ruleId === "MI102_MUTATION_SURVIVED");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ file: `src/age.${ext(fw)}`, startLine: 2, severity: "warn" });
    expect(report.mutation.survived).toBeGreaterThan(0);
  });
});

describe("mutation budgets and failures (jest)", () => {
  it("enforces the max-mutant budget", async () => {
    const repo = setup("jest", "version: 1\nmutation:\n  maxMutants: 2\n");
    repo.write({
      "src/age.js": SRC.jest("return age >= 18 && age < 200 ? true : age === -1;"),
      "test/age.test.js": TEST.jest(
        `  it("treats 40 as adult", () => { expect(isAdult(40)).toBe(true); });\n  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`,
      ),
    });
    repo.commit("complex condition");
    const report = await check(repo);
    expect(report.error).toBeUndefined();
    expect(report.mutation.status).toBe("completed");
    expect(report.mutation.candidates).toBeGreaterThan(2);
    expect(report.mutation.attempted).toBeGreaterThan(0);
    expect(report.mutation.attempted).toBeLessThanOrEqual(2);
    expect(report.mutation.sampled).toBe(true);
  });

  it("returns ERROR when mutation testing exceeds its time budget", async () => {
    const repo = setup("jest", "version: 1\nmutation:\n  timeoutSeconds: 1\n");
    repo.write({
      "src/age.js": SRC.jest("return age >= 18;"),
      "test/age.test.js": TEST.jest(`  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`),
    });
    repo.commit("fix");
    const report = await check(repo);
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("MUTATION_FAILED");
    expect(report.mutation.status).toBe("error");
  });

  it("returns ERROR (never PASS) when Stryker cannot start", async () => {
    const repo = setup("jest");
    repo.write({
      "src/age.js": SRC.jest("return age >= 18;"),
      "test/age.test.js": TEST.jest(`  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`),
      "jest.config.js": 'module.exports = { testEnvironment: "./does-not-exist-environment.js" };\n',
    });
    repo.commit("broken jest config");
    const report = await check(repo, { redGreen: false });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("MUTATION_FAILED");
    expect(report.error?.message).toMatch(/Stryker failed/);
  });

  it("returns ERROR for a runner version Stryker is not validated with (Vitest 5)", async () => {
    const repo = createRepo({ fixture: "vitest5-basic" });
    repos.push(repo);
    repo.write({
      "src/age.ts": SRC.vitest("return age < 18;"),
      "test/age.test.ts": TEST.vitest(""),
    });
    repo.commit("base");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      "src/age.ts": SRC.vitest("return age >= 18;"),
      "test/age.test.ts": TEST.vitest(`  it("treats 18 as adult", () => { expect(isAdult(18)).toBe(true); });\n  it("treats 17 as minor", () => { expect(isAdult(17)).toBe(false); });`),
    });
    repo.commit("fix");
    const report = await check(repo);
    expect(report.redGreen.verifiedFiles).toBe(1);
    expect(report.status).toBe("error");
    expect(report.error?.message).toMatch(/vitest 5\.0\.1 is not validated/);
  });

  it("is not applicable when only tests change", async () => {
    const repo = setup("jest");
    repo.write({ "test/age.test.js": TEST.jest(`  it("treats 40 as adult", () => { expect(isAdult(40)).toBe(true); });\n  it("treats 90 as adult", () => { expect(isAdult(90)).toBe(true); });`) });
    repo.commit("more tests");
    const report = await check(repo);
    expect(report.mutation.status).toBe("not-applicable");
    expect(report.status).toBe("pass");
  });
});
