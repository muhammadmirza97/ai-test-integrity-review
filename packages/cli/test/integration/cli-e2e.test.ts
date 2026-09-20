import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRepo, REPO_ROOT, type TempRepo } from "../../../../test-support/repo.js";

const BIN = join(REPO_ROOT, "packages", "cli", "dist", "main.js");
const repos: TempRepo[] = [];

function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`built CLI not found at ${BIN}; run "pnpm build" first`);
});
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
});

describe("built merge-integrity binary", () => {
  it("prints help", () => {
    const result = run(["--help"], REPO_ROOT);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: merge-integrity");
  });

  it("runs doctor against the Jest fixture", () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    const result = run(["doctor"], repo.dir);
    expect(result.stdout).toContain("jest detected");
    expect(result.code).toBe(0);
  });

  it("keeps unsupported test discovery (MI107) as WARN with exit 0 for a local check under the default policy", () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({ "jest.config.js": 'module.exports = { testRegex: "(/test/.*|\\\\.check)\\\\.js$" };\n' });
    const base = repo.commit("custom discovery");
    repo.write({ "src/math.check.js": 'const { add } = require("./math");\n\nit("adds", () => {\n  expect(add(1, 1)).toBe(2);\n});\n' });
    repo.commit("add a file the custom discovery may treat as a test");
    const result = run(["check", "--base", base], repo.dir);
    expect(result.stdout).toContain("MI107_TEST_DISCOVERY_UNSUPPORTED");
    expect(result.stdout).toContain("WARN");
    expect(result.code, result.stdout).toBe(0);
  });
});
