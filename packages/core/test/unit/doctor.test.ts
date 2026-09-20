import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/environment/doctor.js";
import { createRepo, type TempRepo } from "../../../../test-support/repo.js";

/**
 * Preflight over real repositories. The "calibration incompatibility" cases reproduce the repository setups that
 * made runs ERROR in the 58-PR calibration (CALIBRATION_RESULTS.md); each one must be identified before anything
 * is executed. The negative controls are fixtures that the product verifiably supports.
 */

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
});

const levelOf = (checks: { id: string; level: string }[], id: string) => checks.find((c) => c.id === id)?.level;

describe("doctor: supported repositories", () => {
  it("reports SUPPORTED for the Jest fixture", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("supported");
    expect(report.ok).toBe(true);
    expect(report.framework).toBe("jest");
    expect(report.checks.every((c) => c.level === "ok")).toBe(true);
  });

  it("reports SUPPORTED for the Vitest 4 fixture", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("supported");
    expect(levelOf(report.checks, "vitest-browser-mode")).toBe("ok");
  });

  it("reports Vitest 5 as supported, warning only that mutation testing is not validated there", async () => {
    const repo = createRepo({ fixture: "vitest5-basic" });
    repos.push(repo);
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.ok).toBe(true);
    expect(report.verdict).toBe("supported-with-warnings");
    expect(levelOf(report.checks, "framework-version")).toBe("ok");
    expect(levelOf(report.checks, "stryker")).toBe("warn");
    expect(report.checks.filter((c) => c.level === "warn").map((c) => c.id)).toEqual(["stryker"]);
  });
});

describe("doctor: known calibration incompatibilities", () => {
  it("detects Yarn Plug'n'Play before anything runs (es-toolkit)", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    repo.write({
      ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.12.0.cjs\n",
      "yarn.lock": "__metadata:\n  version: 8\n",
      "package.json": JSON.stringify(
        { name: "pnp-fixture", private: true, type: "module", packageManager: "yarn@4.12.0", scripts: { test: "vitest run" }, devDependencies: { vitest: "4.1.10" } },
        null,
        2,
      ),
    });
    repo.commit("pnp");
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("unsupported");
    expect(levelOf(report.checks, "package-manager")).toBe("fail");
    expect(report.checks.find((c) => c.id === "package-manager")?.remedy).toContain("nodeLinker: node-modules");
  });

  it("detects a Jest configuration that only the test script can find (react-hook-form)", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      "package.json": JSON.stringify(
        { name: "config-only-fixture", private: true, scripts: { test: "jest --config ./scripts/jest/jest.config.js" }, devDependencies: { jest: "30.5.1" } },
        null,
        2,
      ),
      "scripts/jest/jest.config.js": "module.exports = { testMatch: ['**/spec/**/*.js'] };\n",
    });
    repo.commit("config only in test script");
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("unsupported");
    expect(levelOf(report.checks, "test-configuration")).toBe("fail");
  });

  it("detects Vitest browser mode (axios)", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    repo.write({
      "vitest.config.ts": `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/**/*.test.ts"] } },
      { test: { name: "browser", include: ["browser/**/*.test.ts"], browser: { enabled: true, instances: [{ browser: "chromium" }] } } },
    ],
  },
});
`,
    });
    repo.commit("browser mode");
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("unsupported");
    expect(levelOf(report.checks, "vitest-browser-mode")).toBe("fail");
  });

  it("warns about colour-dependent snapshots (jest-extended)", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      "package.json": JSON.stringify(
        { name: "colour-fixture", private: true, jest: { testMatch: ["**/test/**/*.test.ts"] }, scripts: { test: "jest --color=true" }, devDependencies: { jest: "30.5.1" } },
        null,
        2,
      ),
    });
    repo.commit("colour");
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("supported-with-warnings");
    expect(report.ok).toBe(true);
    expect(levelOf(report.checks, "test-output-flags")).toBe("warn");
  });

  it("warns about environment variables the test script sets (luxon-style test scripts)", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      "package.json": JSON.stringify(
        { name: "tz-fixture", private: true, jest: {}, scripts: { test: "cross-env TZ=America/New_York LANG=en_US jest" }, devDependencies: { jest: "30.5.1" } },
        null,
        2,
      ),
    });
    repo.commit("tz");
    const report = await runDoctor({ cwd: repo.dir });
    expect(levelOf(report.checks, "test-environment")).toBe("warn");
    expect(report.checks.find((c) => c.id === "test-environment")?.remedy).toContain("passthrough");
  });
});

describe("doctor: other conditions", () => {
  it("warns when test discovery cannot be read statically (MI107)", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({ "jest.config.js": "module.exports = { testRegex: 'test/.*\\\\.ts$' };\n" });
    repo.commit("testRegex");
    const report = await runDoctor({ cwd: repo.dir });
    expect(levelOf(report.checks, "test-discovery")).toBe("warn");
    expect(report.verdict).toBe("supported-with-warnings");
  });

  it("warns at a workspace root", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "jest" }, devDependencies: { jest: "30.5.1" } }, null, 2),
    });
    repo.commit("workspaces");
    const report = await runDoctor({ cwd: repo.dir });
    expect(levelOf(report.checks, "workspaces")).toBe("warn");
  });

  it("fails when dependencies are not installed", async () => {
    const repo = createRepo({ fixture: "jest-basic", linkNodeModules: false });
    repos.push(repo);
    const report = await runDoctor({ cwd: repo.dir });
    expect(report.verdict).toBe("unsupported");
    expect(levelOf(report.checks, "dependencies")).toBe("fail");
  });

  it("every non-ok check explains what to do", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    repo.write({ ".yarnrc.yml": "nodeLinker: pnp\n", "yarn.lock": "__metadata:\n" });
    repo.commit("pnp");
    const report = await runDoctor({ cwd: repo.dir });
    for (const check of report.checks.filter((c) => c.level !== "ok")) {
      expect(check.remedy, check.id).toBeTruthy();
    }
  });
});
