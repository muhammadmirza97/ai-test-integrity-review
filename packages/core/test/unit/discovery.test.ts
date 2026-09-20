import { describe, expect, it } from "vitest";
import { discoverTestFiles } from "../../src/framework/discovery.js";
import type { ProjectFileReader } from "../../src/framework/detect.js";

function reader(files: Record<string, string>): ProjectFileReader {
  return { readText: async (p) => files[p], exists: async (p) => p in files };
}

describe("discoverTestFiles", () => {
  it("uses default patterns when no discovery settings exist", async () => {
    const d = await discoverTestFiles(reader({ "package.json": "{}" }), "jest");
    expect(d.kind).toBe("default");
    expect(d.isTestFile("src/a.test.ts")).toBe(true);
    expect(d.isTestFile("tests/a.js")).toBe(false);
  });

  it("adds static Jest testMatch patterns from jest.config.js (with <rootDir>)", async () => {
    const d = await discoverTestFiles(reader({ "package.json": "{}", "jest.config.js": 'module.exports = { testMatch: ["<rootDir>/tests/**/*.js"] };' }), "jest");
    expect(d.kind).toBe("custom");
    expect(d.isTestFile("tests/unit/login.js")).toBe(true);
    expect(d.isTestFile("src/a.test.ts")).toBe(true);
    expect(d.isTestFile("src/login.js")).toBe(false);
  });

  it("reads testMatch from the package.json jest field", async () => {
    const d = await discoverTestFiles(reader({ "package.json": JSON.stringify({ jest: { testMatch: ["**/specs/**/*.ts"] } }) }), "jest");
    expect(d.isTestFile("app/specs/x.ts")).toBe(true);
  });

  it("adds static Vitest include patterns and dir from defineConfig", async () => {
    const d = await discoverTestFiles(
      reader({ "package.json": "{}", "vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { dir: "qa", include: ["**/*.check.ts"] } });' }),
      "vitest",
    );
    expect(d.kind).toBe("custom");
    expect(d.isTestFile("qa/login.check.ts")).toBe(true);
    expect(d.isTestFile("src/login.check.ts")).toBe(false);
  });

  it.each([
    ["jest testRegex", "jest", { "jest.config.js": 'module.exports = { testRegex: "(/tests/.*|\\\\.t)\\\\.js$" };' }],
    ["jest projects", "jest", { "jest.config.js": 'module.exports = { projects: ["<rootDir>/a"] };' }],
    ["dynamic jest config", "jest", { "jest.config.js": 'const base = require("./base");\nmodule.exports = base;' }],
    ["computed testMatch", "jest", { "jest.config.js": "const m = [\"**/*.t.js\"];\nmodule.exports = { testMatch: m };" }],
    ["spread config", "jest", { "jest.config.js": "module.exports = { ...shared, verbose: true };" }],
    ["vitest workspace file", "vitest", { "vitest.workspace.ts": 'export default ["packages/*"];' }],
    ["vitest projects", "vitest", { "vitest.config.ts": 'export default { test: { projects: ["a"] } };' }],
    ["dynamic vitest include", "vitest", { "vitest.config.ts": "export default { test: { include: patterns } };" }],
  ])("reports %s as unsupported instead of implying full coverage", async (_name, framework, files) => {
    const d = await discoverTestFiles(reader({ "package.json": "{}", ...files }), framework as "jest" | "vitest");
    expect(d.kind).toBe("unsupported");
    expect(d.isTestFile("src/a.test.ts")).toBe(true);
  });

  it("does not treat unrelated static config as unsupported", async () => {
    const d = await discoverTestFiles(reader({ "package.json": "{}", "jest.config.js": 'module.exports = { verbose: true, testEnvironment: "node" };' }), "jest");
    expect(d.kind).toBe("default");
  });
});
