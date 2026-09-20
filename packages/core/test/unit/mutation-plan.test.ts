import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MutationError } from "../../src/mutation/adapter.js";
import { checkCompatibility, planMutants, StrykerAdapter, type PlannedMutant } from "../../src/mutation/stryker.js";
import { untrustedEnv } from "../../src/process/env.js";

const m = (line: number, col: number, endCol: number, mutatorName = "EqualityOperator", replacement = "x"): PlannedMutant => ({
  file: "src/a.ts",
  mutatorName,
  replacement,
  start: { line, column: col },
  end: { line, column: endCol },
});

describe("planMutants", () => {
  const targets = [{ file: "src/a.ts", ranges: [{ start: 1, end: 10 }] }];

  it("uses the changed line ranges when every candidate fits the budget", () => {
    const plan = planMutants([m(0, 0, 5), m(1, 0, 5)], targets, 5);
    expect(plan).toMatchObject({ mutate: ["src/a.ts:1-10"], sampled: false });
    expect(plan.selected).toHaveLength(2);
  });

  it("never selects more mutants than the budget, including nested mutants of a chosen range", () => {
    const outer = m(0, 0, 20, "BlockStatement", "{}");
    const innerA = m(0, 5, 10, "EqualityOperator", "a < b");
    const innerB = m(0, 5, 10, "ConditionalExpression", "true");
    const later = m(3, 0, 4, "BooleanLiteral", "false");
    const plan = planMutants([later, innerB, outer, innerA], targets, 2);
    expect(plan.sampled).toBe(true);
    expect(plan.selected.length).toBeLessThanOrEqual(2);
    // The outer block would include 3 mutants, so it is skipped; the two inner mutants share one range.
    expect(plan.selected.map((s) => s.mutatorName).sort()).toEqual(["ConditionalExpression", "EqualityOperator"]);
    expect(plan.mutate).toEqual(["src/a.ts:1:5-1:10"]);
  });

  it("is deterministic regardless of input order", () => {
    const list = [m(2, 0, 3), m(0, 1, 2), m(1, 0, 9), m(5, 0, 1)];
    expect(planMutants(list, targets, 2)).toEqual(planMutants([...list].reverse(), targets, 2));
  });
});

describe("checkCompatibility", () => {
  it("accepts validated Stryker and runner versions", () => {
    expect(checkCompatibility("10.0.0", "jest", "30.5.1")).toBeUndefined();
    expect(checkCompatibility("10.0.0", "jest", "29.7.0")).toBeUndefined();
    expect(checkCompatibility("10.0.0", "vitest", "4.1.10")).toBeUndefined();
  });

  it("rejects unvalidated versions instead of producing meaningless survivors", () => {
    expect(checkCompatibility("10.0.0", "vitest", "5.0.1")).toMatch(/vitest 5\.0\.1 is not validated/);
    expect(checkCompatibility("9.6.0", "jest", "30.0.0")).toMatch(/core 9\.6\.0/);
    expect(checkCompatibility("10.0.0", "jest", undefined)).toMatch(/not installed/);
  });
});

describe("StrykerAdapter failure handling (fake Stryker installs)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function fakeProject(options: { coreBin?: string; instrumenter?: string; runner?: boolean }): string {
    const dir = mkdtempSync(join(tmpdir(), "mi-fake-stryker-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "scratch"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "src", "a.js"), "module.exports = (a) => a > 1;\n");
    if (options.coreBin !== undefined) {
      const core = join(dir, "node_modules", "@stryker-mutator", "core");
      mkdirSync(join(core, "bin"), { recursive: true });
      writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@stryker-mutator/core", version: "10.0.0", bin: { stryker: "bin/stryker.js" } }));
      const jest = join(dir, "node_modules", "jest");
      mkdirSync(jest, { recursive: true });
      writeFileSync(join(jest, "package.json"), JSON.stringify({ name: "jest", version: "30.5.1" }));
      writeFileSync(join(core, "bin", "stryker.js"), options.coreBin);
      const instr = join(dir, "node_modules", "@stryker-mutator", "instrumenter");
      mkdirSync(instr, { recursive: true });
      writeFileSync(join(instr, "package.json"), JSON.stringify({ name: "@stryker-mutator/instrumenter", version: "0.0.0", exports: { ".": "./index.mjs" } }));
      writeFileSync(
        join(instr, "index.mjs"),
        options.instrumenter ??
          `export class Instrumenter { async instrument(files) { return { mutants: [{ fileName: files[0].name, mutatorName: "EqualityOperator", replacement: "a < 1", location: { start: { line: 0, column: 22 }, end: { line: 0, column: 27 } } }] }; } }\n`,
      );
    }
    if (options.runner !== false) {
      const runner = join(dir, "node_modules", "@stryker-mutator", "jest-runner");
      mkdirSync(runner, { recursive: true });
      writeFileSync(join(runner, "package.json"), JSON.stringify({ name: "@stryker-mutator/jest-runner", version: "0.0.0" }));
    }
    return dir;
  }

  const run = (dir: string, timeoutMs = 60_000) =>
    new StrykerAdapter().run({
      projectDir: dir,
      root: dir,
      scratchDir: join(dir, "scratch"),
      framework: "jest",
      targets: [{ file: "src/a.js", ranges: [{ start: 1, end: 1 }] }],
      timeoutMs,
      maxMutants: 10,
      env: untrustedEnv(),
      node: process.execPath,
    });

  it("fails with an actionable error when Stryker is not installed", async () => {
    const dir = fakeProject({ runner: false });
    await expect(run(dir)).rejects.toThrow(/requires @stryker-mutator\/core/);
  });

  it("treats a Stryker startup failure as an error, never as all mutants killed", async () => {
    const dir = fakeProject({ coreBin: `console.error("Error: Could not load jest config"); process.exit(1);\n` });
    await expect(run(dir)).rejects.toThrow(MutationError);
    await expect(run(dir)).rejects.toThrow(/Stryker failed/);
  });

  it("treats exit code 0 without a report as an error", async () => {
    const dir = fakeProject({ coreBin: "process.exit(0);\n" });
    await expect(run(dir)).rejects.toThrow(/valid mutation report/);
  });

  it("rejects a report containing mutants outside the plan", async () => {
    const bin = `const fs=require("fs");const cfg=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
fs.writeFileSync(cfg.jsonReporter.fileName, JSON.stringify({ files: { "src/a.js": { mutants: [
  { mutatorName: "EqualityOperator", replacement: "a < 1", status: "Killed", location: { start: { line: 1, column: 23 }, end: { line: 1, column: 28 } } },
  { mutatorName: "BooleanLiteral", replacement: "true", status: "Killed", location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } }
] } } }));\n`;
    await expect(run(fakeProject({ coreBin: bin }))).rejects.toThrow(/outside the planned set/);
  });

  it("rejects a report that omits planned mutants", async () => {
    const bin = `const fs=require("fs");const cfg=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));fs.writeFileSync(cfg.jsonReporter.fileName, JSON.stringify({ files: {} }));\n`;
    await expect(run(fakeProject({ coreBin: bin }))).rejects.toThrow(/0 of 1 planned/);
  });

  it("rejects pending or unknown mutant statuses", async () => {
    const bin = `const fs=require("fs");const cfg=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
fs.writeFileSync(cfg.jsonReporter.fileName, JSON.stringify({ files: { "src/a.js": { mutants: [
  { mutatorName: "EqualityOperator", replacement: "a < 1", status: "Pending", location: { start: { line: 1, column: 23 }, end: { line: 1, column: 28 } } }
] } } }));\n`;
    await expect(run(fakeProject({ coreBin: bin }))).rejects.toThrow(/incomplete mutant status/);
  });

  it("accepts a consistent report", async () => {
    const bin = `const fs=require("fs");const cfg=JSON.parse(fs.readFileSync(process.argv[3],"utf8"));
fs.writeFileSync(cfg.jsonReporter.fileName, JSON.stringify({ files: { "src/a.js": { mutants: [
  { mutatorName: "EqualityOperator", replacement: "a < 1", status: "Survived", location: { start: { line: 1, column: 23 }, end: { line: 1, column: 28 } } }
] } } }));\n`;
    const result = await run(fakeProject({ coreBin: bin }));
    expect(result).toMatchObject({ candidates: 1, sampled: false });
    expect(result.mutants).toEqual([{ file: "src/a.js", line: 1, column: 23, mutator: "EqualityOperator", replacement: "a < 1", status: "survived" }]);
  });

  it("enforces the time budget by killing Stryker", async () => {
    const dir = fakeProject({ coreBin: "setInterval(() => {}, 1000);\n" });
    const started = Date.now();
    await expect(run(dir, 3_000)).rejects.toThrow(/time budget/);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("refuses to target file names containing glob characters", async () => {
    const dir = fakeProject({ coreBin: "process.exit(0);\n" });
    await expect(
      new StrykerAdapter().run({
        projectDir: dir,
        root: dir,
        scratchDir: join(dir, "scratch"),
        framework: "jest",
        targets: [{ file: "src/a[1].js", ranges: [{ start: 1, end: 1 }] }],
        timeoutMs: 10_000,
        maxMutants: 5,
        env: untrustedEnv(),
        node: process.execPath,
      }),
    ).rejects.toThrow(/glob characters/);
  });
});
