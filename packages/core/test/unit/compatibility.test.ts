import { describe, expect, it } from "vitest";
import {
  analyzeTestScript,
  browserModeFinding,
  detectPackageManager,
  detectVitestBrowserMode,
  frameworkVersionFinding,
  packageManagerFinding,
  testScriptFindings,
} from "../../src/environment/compatibility.js";

/**
 * The cases below are the repository setups that produced ERROR in the 58-PR calibration
 * (CALIBRATION_RESULTS.md, "Installation/repository compatibility"), reproduced from the real configuration of
 * those repositories, plus negative controls from repositories in the same corpus that worked.
 */

describe("package manager detection", () => {
  it("reports Yarn Berry without nodeLinker as Plug'n'Play (calibration: toss/es-toolkit)", () => {
    const detection = detectPackageManager({
      packageManagerField: "yarn@4.12.0",
      yarnrcYml: "npmScopes:\n  jsr:\n    npmRegistryServer: 'https://npm.jsr.io'\nyarnPath: .yarn/releases/yarn-4.12.0.cjs\n",
      yarnLock: "__metadata:\n  version: 8\n",
    });
    expect(detection).toMatchObject({ manager: "yarn", nodeLinker: "pnp", pnp: true });
    const finding = packageManagerFinding(detection);
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("Plug'n'Play");
    expect(finding.remedy).toContain("nodeLinker: node-modules");
  });

  it("accepts Yarn Berry with nodeLinker: node-modules (calibration: jest-community/jest-extended)", () => {
    const detection = detectPackageManager({
      packageManagerField: "yarn@4.18.0",
      yarnrcYml: "cacheFolder: .yarn/cache\n\nenableGlobalCache: true\n\nnodeLinker: node-modules\n\npnpMode: loose\n",
      yarnLock: "__metadata:\n  version: 8\n",
    });
    expect(detection).toMatchObject({ manager: "yarn", nodeLinker: "node-modules", pnp: false });
    expect(packageManagerFinding(detection).level).toBe("ok");
  });

  it("treats a .pnp.cjs file as Plug'n'Play whatever the lockfile says", () => {
    const detection = detectPackageManager({ hasPnpFile: true, yarnLock: "__metadata:\n", yarnrcYml: "nodeLinker: node-modules\n" });
    expect(detection.pnp).toBe(true);
  });

  it("treats Yarn 1 as node_modules", () => {
    const detection = detectPackageManager({ yarnLock: '# yarn lockfile v1\n\n"@babel/code-frame@^7.0.0":\n' });
    expect(detection).toMatchObject({ manager: "yarn", nodeLinker: "node-modules", pnp: false });
  });

  it("recognises npm and pnpm lockfiles", () => {
    expect(detectPackageManager({ hasNpmLock: true })).toMatchObject({ manager: "npm", pnp: false });
    expect(detectPackageManager({ hasPnpmLock: true })).toMatchObject({ manager: "pnpm", pnp: false });
  });

  it("warns when nothing identifies how dependencies are installed", () => {
    expect(packageManagerFinding(detectPackageManager({})).level).toBe("warn");
  });

  it("does not treat an unreadable .yarnrc.yml as node-modules", () => {
    const detection = detectPackageManager({ packageManagerField: "yarn@4.0.0", yarnrcYml: "nodeLinker: [oops\n" });
    expect(detection.pnp).toBe(true);
  });
});

describe("Vitest browser mode detection", () => {
  const axiosConfig = `import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    testTimeout: 10000,
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.js'] } },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.browser.test.js'],
          browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
        },
      },
    ],
  },
});
`;

  it("finds browser mode inside a projects entry (calibration: axios/axios)", () => {
    const detection = detectVitestBrowserMode(axiosConfig, "vitest.config.js");
    expect(detection.enabled).toBe(true);
    const finding = browserModeFinding(detection, "vitest.config.js");
    expect(finding.level).toBe("fail");
    expect(finding.message).toContain("browser mode");
  });

  it("finds a top-level browser block", () => {
    const detection = detectVitestBrowserMode(
      "export default { test: { browser: { enabled: true, name: 'chromium' } } };",
      "vitest.config.ts",
    );
    expect(detection).toMatchObject({ enabled: true, path: "test.browser" });
  });

  it("does not report browser mode that is present but disabled", () => {
    expect(detectVitestBrowserMode("export default { test: { browser: { enabled: false } } };", "vitest.config.ts").enabled).toBe(false);
  });

  it("does not report a config without browser settings (calibration: pmndrs/zustand)", () => {
    const detection = detectVitestBrowserMode(
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true, environment: 'jsdom' } });",
      "vitest.config.ts",
    );
    expect(detection.enabled).toBe(false);
    expect(browserModeFinding(detection, "vitest.config.ts").level).toBe("ok");
  });

  it("does not report an unrelated property called browser", () => {
    expect(detectVitestBrowserMode("export default { build: { browser: 'chrome100' } };", "vite.config.js").enabled).toBe(false);
  });

  it("treats an unparsable config as no evidence rather than a failure", () => {
    expect(detectVitestBrowserMode("export default {{{", "vitest.config.ts").enabled).toBe(false);
  });
});

describe("test script analysis", () => {
  it("fails a Jest config reachable only through the test script (calibration: react-hook-form)", () => {
    const analysis = analyzeTestScript({ test: "jest --config ./scripts/jest/jest.config.js" }, "jest");
    expect(analysis).toMatchObject({ invokesFramework: true, configFlags: ["--config"] });
    const findings = testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: false, hasPretest: false });
    const config = findings.find((f) => f.id === "test-configuration");
    expect(config?.level).toBe("fail");
    expect(config?.remedy).toContain("jest.config");
  });

  it("only warns about --config when a discoverable config also exists", () => {
    const analysis = analyzeTestScript({ test: "jest --config jest.ci.config.js" }, "jest");
    const findings = testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: true, hasPretest: false });
    expect(findings.find((f) => f.id === "test-configuration")?.level).toBe("warn");
  });

  it("warns about colour flags that break snapshots (calibration: jest-extended #885)", () => {
    const analysis = analyzeTestScript({ test: "jest --color=true" }, "jest");
    expect(analysis.outputFlags).toEqual(["--color"]);
    const findings = testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: true, hasPretest: false });
    const colour = findings.find((f) => f.id === "test-output-flags");
    expect(colour?.level).toBe("warn");
    expect(colour?.message).toContain("snapshot");
  });

  it("follows npm run indirection (calibration: axios)", () => {
    const analysis = analyzeTestScript({ test: "npm run test:vitest", "test:vitest": "vitest run" }, "vitest");
    expect(analysis.chain).toEqual(["test", "test:vitest"]);
    expect(analysis.invokesFramework).toBe(true);
    expect(testScriptFindings(analysis, { framework: "vitest", hasDiscoverableConfig: true, hasPretest: false })).toEqual([]);
  });

  it("reports environment variables set by the test script", () => {
    const analysis = analyzeTestScript({ test: "TZ=America/New_York LANG=en_US jest --coverage" }, "jest");
    expect(analysis.environmentAssignments).toEqual(["TZ", "LANG"]);
    const finding = testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: true, hasPretest: false }).find(
      (f) => f.id === "test-environment",
    );
    expect(finding?.level).toBe("warn");
    expect(finding?.remedy).toContain("passthrough");
  });

  it("reads cross-env assignments", () => {
    const analysis = analyzeTestScript({ test: "cross-env NODE_ENV=test TZ=UTC vitest run" }, "vitest");
    expect(analysis.environmentAssignments).toEqual(["NODE_ENV", "TZ"]);
    expect(analysis.invokesFramework).toBe(true);
  });

  it("reports a build step that runs before the tests", () => {
    const analysis = analyzeTestScript({ test: "npm run build && jest" }, "jest");
    expect(analysis.precedingCommand).toBe("npm run build");
    expect(testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: true, hasPretest: false }).some((f) => f.id === "test-build-step")).toBe(true);
  });

  it("reports a pretest script", () => {
    const analysis = analyzeTestScript({ test: "vitest run", pretest: "tsc -p ." }, "vitest");
    expect(testScriptFindings(analysis, { framework: "vitest", hasDiscoverableConfig: true, hasPretest: true }).some((f) => f.id === "test-build-step")).toBe(true);
  });

  it("warns when the test script does not invoke the framework", () => {
    const analysis = analyzeTestScript({ test: "node ./scripts/run-tests.js" }, "vitest");
    expect(analysis.customRunner).toBe(true);
    expect(testScriptFindings(analysis, { framework: "vitest", hasDiscoverableConfig: true, hasPretest: false })[0]?.id).toBe("test-command");
  });

  it("warns when there is no test script at all", () => {
    const analysis = analyzeTestScript({}, "jest");
    expect(analysis.resolved).toBeUndefined();
    expect(testScriptFindings(analysis, { framework: "jest", hasDiscoverableConfig: true, hasPretest: false })[0]?.level).toBe("warn");
  });

  it("accepts the plain invocations used by most of the corpus", () => {
    for (const [script, framework] of [
      ["jest", "jest"],
      ["jest --coverage", "jest"],
      ["vitest run", "vitest"],
      ["vitest --coverage", "vitest"],
      ["npx vitest run", "vitest"],
      ["yarn jest", "jest"],
    ] as const) {
      const analysis = analyzeTestScript({ test: script }, framework);
      expect(analysis.invokesFramework, script).toBe(true);
      expect(testScriptFindings(analysis, { framework, hasDiscoverableConfig: true, hasPretest: false }), script).toEqual([]);
    }
  });

  it("does not loop on self-referential scripts", () => {
    const analysis = analyzeTestScript({ test: "npm run test" }, "jest");
    expect(analysis.chain).toEqual(["test"]);
  });
});

describe("framework version support", () => {
  it("accepts validated majors", () => {
    expect(frameworkVersionFinding("jest", "30.5.1").level).toBe("ok");
    expect(frameworkVersionFinding("vitest", "4.1.10").level).toBe("ok");
    expect(frameworkVersionFinding("vitest", "5.0.1").level).toBe("ok");
  });

  it("warns, but never fails, outside them", () => {
    expect(frameworkVersionFinding("jest", "26.0.0").level).toBe("warn");
    expect(frameworkVersionFinding("vitest", "1.6.0").level).toBe("warn");
    expect(frameworkVersionFinding("jest", undefined).level).toBe("warn");
  });
});
