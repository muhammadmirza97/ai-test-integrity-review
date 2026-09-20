#!/usr/bin/env node
// Synthetic tampering validation.
//
// For each fixture framework, builds a throwaway Git repository with a green base, applies one known
// tampering (or clean) change as a PR commit, runs the built merge-integrity CLI, and compares the decision
// with the expected one. Everything runs locally; nothing is cloned or uploaded.
//
// Usage: node scripts/validation/synthetic-tampering.mjs [--framework jest|vitest] [--out validation-results]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "packages", "cli", "dist", "main.js");
const { values } = parseArgs({ options: { framework: { type: "string" }, out: { type: "string", default: "validation-results" } } });
if (!existsSync(cli)) {
  console.error(`Built CLI not found at ${cli}. Run "pnpm build" first.`);
  process.exit(2);
}

const FW = {
  jest: {
    fixture: "jest-basic",
    ext: "js",
    src: (cond) => `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  return ${cond};\n}\n\nmodule.exports = { add, isAdult };\n`,
    header: `const { add, isAdult } = require("../src/math");\n`,
  },
  vitest: {
    fixture: "vitest-basic",
    ext: "ts",
    src: (cond) => `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function isAdult(age: number): boolean {\n  return ${cond};\n}\n`,
    header: `import { describe, expect, it } from "vitest";\nimport { add, isAdult } from "../src/math";\n`,
  },
};

const tests = (fw, body) => `${FW[fw].header}\ndescribe("math", () => {\n${body}\n});\n`;
const ADD = `  it("adds", () => {\n    expect(add(2, 3)).toBe(5);\n    expect(add(-1, 1)).toBe(0);\n  });`;
const ADULT = `  it("treats 18 as adult", () => {\n    expect(isAdult(18)).toBe(true);\n    expect(isAdult(17)).toBe(false);\n  });`;

/** Each scenario: base files, PR files, expected status and (optionally) a rule that must be present. */
const SCENARIOS = [
  { id: "clean-strengthened-test", expect: "pass", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n${ADULT}\n  it("adds zero", () => { expect(add(0, 0)).toBe(0); });`) }) },
  { id: "test-skipped", expect: "block", rule: "MI001_TEST_SKIPPED", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n${ADULT.replace("it(", "it.skip(")}`) }) },
  { id: "test-focused", expect: "block", rule: "MI002_TEST_FOCUSED", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD.replace("it(", "it.only(")}\n${ADULT}`) }) },
  { id: "assertion-removed", expect: "warn", rule: "MI003_ASSERTION_REMOVED", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n${ADULT.replace("\n    expect(isAdult(17)).toBe(false);", "")}`) }) },
  { id: "assertion-weakened", expect: "block", rule: "MI004_ASSERTION_WEAKENED", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n${ADULT.replace("expect(isAdult(18)).toBe(true)", "expect(isAdult(18)).toBeDefined()")}`) }) },
  { id: "equivalent-rewrite", expect: "pass", pr: (fw) => ({ [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD.replace("expect(add(2, 3)).toBe(5)", "expect({ sum: add(2, 3) }).toMatchObject({ sum: 5 })")}\n${ADULT}`) }) },
  {
    id: "test-command-bypass",
    expect: "block",
    rule: "MI005_TEST_COMMAND_BYPASS",
    pr: (fw, manifest) => ({ "package.json": JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, test: `${manifest.scripts.test} --passWithNoTests` } }, null, 2) }),
  },
  {
    id: "fake-regression-test",
    expect: "warn",
    rule: "MI006_REGRESSION_TEST_NON_DISCRIMINATING",
    baseSrc: "age > 18",
    pr: (fw) => ({ [`src/math.${FW[fw].ext}`]: FW[fw].src("age >= 18"), [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n  it("treats 40 as adult", () => { expect(isAdult(40)).toBe(true); });`) }),
  },
  {
    id: "real-regression-test",
    expect: "pass",
    baseSrc: "age > 18",
    baseTests: (fw) => tests(fw, ADD),
    pr: (fw) => ({ [`src/math.${FW[fw].ext}`]: FW[fw].src("age >= 18"), [`test/math.test.${FW[fw].ext}`]: tests(fw, `${ADD}\n${ADULT}`) }),
  },
];

function git(dir, ...args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function runScenario(fw, scenario) {
  const def = FW[fw];
  const fixture = join(root, "test-repos", def.fixture);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mi-synthetic-")));
  const modules = join(dir, "node_modules");
  try {
    cpSync(fixture, dir, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.endsWith("package-lock.json") });
    symlinkSync(join(fixture, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const manifest = JSON.parse(spawnSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], { cwd: dir, encoding: "utf8" }).stdout);
    writeFileSync(join(dir, `src/math.${def.ext}`), def.src(scenario.baseSrc ?? "age >= 18"));
    writeFileSync(join(dir, `test/math.test.${def.ext}`), scenario.baseTests ? scenario.baseTests(fw) : tests(fw, scenario.baseSrc ? ADD : `${ADD}\n${ADULT}`));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=validation", "-c", "user.email=validation@example.invalid", "add", "-A");
    git(dir, "-c", "user.name=validation", "-c", "user.email=validation@example.invalid", "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "pr");
    for (const [rel, content] of Object.entries(scenario.pr(fw, manifest))) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    git(dir, "-c", "user.name=validation", "-c", "user.email=validation@example.invalid", "commit", "-q", "-am", scenario.id);
    const started = Date.now();
    const result = spawnSync(process.execPath, [cli, "check", "--base", "main", "--head", "HEAD", "--format", "json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const report = JSON.parse(result.stdout);
    const rules = report.findings.map((f) => f.ruleId);
    const ok = report.status === scenario.expect && (scenario.rule === undefined || rules.includes(scenario.rule));
    return { framework: fw, scenario: scenario.id, expected: scenario.expect, expectedRule: scenario.rule ?? null, status: report.status, rules, exitCode: result.status, ok, durationMs: Date.now() - started, timings: report.timings, error: report.error?.message };
  } finally {
    try {
      if (lstatSync(modules).isSymbolicLink()) (process.platform === "win32" ? rmdirSync : unlinkSync)(modules);
    } catch {
      // not created
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const frameworks = values.framework ? [values.framework] : Object.keys(FW);
const results = [];
for (const fw of frameworks) {
  for (const scenario of SCENARIOS) {
    const r = runScenario(fw, scenario);
    results.push(r);
    console.log(`${r.ok ? "ok  " : "FAIL"} ${fw.padEnd(6)} ${scenario.id.padEnd(26)} expected ${scenario.expect}${scenario.rule ? ` (${scenario.rule})` : ""} got ${r.status} [${r.rules.join(", ")}] ${(r.durationMs / 1000).toFixed(1)}s${r.error ? ` error: ${r.error}` : ""}`);
  }
}
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "synthetic-tampering.json"), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} scenarios matched the expected decision`);
process.exit(failed === 0 ? 0 : 1);
