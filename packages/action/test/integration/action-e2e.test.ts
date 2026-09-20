import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRepo, REPO_ROOT, type TempRepo } from "../../../../test-support/repo.js";

const BUNDLE = join(REPO_ROOT, "packages", "action", "dist", "index.cjs");
const repos: TempRepo[] = [];
const dirs: string[] = [];

beforeAll(() => {
  if (!existsSync(BUNDLE)) throw new Error(`Action bundle not found at ${BUNDLE}; run "pnpm bundle" first`);
});
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const TEST = `const { add, isAdult } = require("../src/math");

describe("math", () => {
  it("adds numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
`;

/** Run the bundled Action as the runner would: node24 with INPUT_* and GITHUB_* environment. */
function runAction(repo: TempRepo, event: { name: string; payload: unknown }, inputs: Record<string, string> = {}) {
  const runnerTemp = mkdtempSync(join(tmpdir(), "mi-runner-"));
  dirs.push(runnerTemp);
  const eventPath = join(runnerTemp, "event.json");
  const outputPath = join(runnerTemp, "output");
  const summaryPath = join(runnerTemp, "summary.md");
  writeFileSync(eventPath, JSON.stringify(event.payload));
  writeFileSync(outputPath, "");
  writeFileSync(summaryPath, "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: event.name,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: repo.dir,
    GITHUB_SHA: repo.git("rev-parse", "HEAD").trim(),
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    RUNNER_TEMP: runnerTemp,
    ACTIONS_RUNTIME_TOKEN: "fake-runtime-token",
    AWS_SECRET_ACCESS_KEY: "fake-aws-secret",
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  const result = spawnSync(process.execPath, [BUNDLE], { cwd: repo.dir, env, encoding: "utf8", timeout: 600_000 });
  const outputs: Record<string, string> = {};
  for (const match of readFileSync(outputPath, "utf8").matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
    outputs[match[1] as string] = match[3] as string;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs, summary: readFileSync(summaryPath, "utf8") };
}

function prRepo(files: Record<string, string>): { repo: TempRepo; base: string } {
  const repo = createRepo({ fixture: "jest-basic" });
  repos.push(repo);
  repo.write({ "test/math.test.js": TEST });
  const base = repo.commit("base");
  repo.git("checkout", "-q", "-b", "pr");
  repo.write(files);
  repo.commit("pr");
  return { repo, base };
}

describe("bundled GitHub Action", () => {
  it("PASSes a clean pull request with exit code 0 and outputs", () => {
    const { repo, base } = prRepo({ "test/math.test.js": TEST.replace("expect(add(2, 3)).toBe(5);", "expect(add(2, 3)).toBe(5);\n    expect(add(1, 1)).toBe(2);") });
    const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({ status: "pass", "blocker-count": "0", "warning-count": "0" });
    expect(existsSync(result.outputs["report-path"] as string)).toBe(true);
    expect(result.summary).toContain("## Merge Integrity: PASS");
    expect(result.stdout).toMatch(/::stop-commands::[0-9a-f]+\n[\s\S]*Merge Integrity: PASS[\s\S]*::[0-9a-f]+::/);
  });

  it("fails the check (exit 1) with annotations for a weakened test", () => {
    const { repo, base } = prRepo({ "test/math.test.js": TEST.replace('it("adds numbers"', 'it.skip("adds numbers"') });
    const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } });
    expect(result.code).toBe(1);
    expect(result.outputs).toMatchObject({ status: "block", "blocker-count": "1" });
    expect(result.stdout).toContain("::error file=test/math.test.js,line=4,title=MI001_TEST_SKIPPED%3A Test skipped::");
    expect(result.summary).toContain("MI001_TEST_SKIPPED");
  });

  it("fails the check (exit 2) on ERROR, e.g. missing base history", () => {
    const { repo } = prRepo({ "src/extra.js": "module.exports = 1;\n" });
    const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: "c".repeat(40) } } } });
    expect(result.code).toBe(2);
    expect(result.outputs.status).toBe("error");
    expect(result.stdout).toContain("::error title=Merge Integrity%3A ERROR::No merge decision was made");
    expect(result.summary).toContain("No merge decision was made.");
  });

  it("refuses pull_request_target with exit 2", () => {
    const { repo, base } = prRepo({ "src/extra.js": "module.exports = 1;\n" });
    const result = runAction(repo, { name: "pull_request_target", payload: { pull_request: { base: { sha: base } } } });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("pull_request_target");
  });

  it("supports merge_group events", () => {
    const { repo, base } = prRepo({ "test/math.test.js": TEST.replace('it("adds numbers"', 'it.only("adds numbers"') });
    const head = repo.git("rev-parse", "HEAD").trim();
    const result = runAction(repo, { name: "merge_group", payload: { merge_group: { base_sha: base, head_sha: head } } });
    expect(result.code).toBe(1);
    expect(result.outputs.status).toBe("block");
  });

  it("runs red/green and mutation end to end without leaking the runtime token", () => {
    const source = (condition: string) =>
      `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  return ${condition};\n}\n\nmodule.exports = { add, isAdult };\n`;
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({ "test/math.test.js": TEST, "src/math.js": source("age > 18") });
    const buggyBase = repo.commit("buggy base");
    repo.git("checkout", "-q", "-b", "pr");
    repo.write({
      "src/math.js": source("age >= 18"),
      "test/math.test.js": TEST.replace(
        '  it("adds numbers"',
        '  it("treats 18 and 17 correctly without seeing runner tokens or secrets", () => {\n    expect(process.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();\n    expect(process.env.GITHUB_OUTPUT).toBeUndefined();\n    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();\n    expect(isAdult(18)).toBe(true);\n    expect(isAdult(17)).toBe(false);\n  });\n\n  it("adds numbers"',
      ),
    });
    repo.commit("fix boundary");
    const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: buggyBase } } } }, { mutation: "true" });
    expect(result.outputs.status, result.stdout).toBe("pass");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Red/green: 1 changed test verified (1 file)");
    expect(result.stdout).toMatch(/Mutation: \d+\/\d+ relevant mutants killed/);
  });

  describe("pull-request-controlled inputs cannot weaken the decision", () => {
    const source = (condition: string) =>
      `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  return ${condition};\n}\n\nmodule.exports = { add, isAdult };\n`;

    /** A PR that "fixes" code with a non-discriminating test: it must never PASS. */
    function fakeFixRepo(extraFiles: Record<string, string> = {}) {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({ "test/math.test.js": TEST, "src/math.js": source("age > 18") });
      const base = repo.commit("buggy base");
      repo.git("checkout", "-q", "-b", "pr");
      repo.write({
        "src/math.js": source("age >= 18"),
        "test/math.test.js": TEST.replace('  it("adds numbers"', '  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });\n\n  it("adds numbers"'),
        ...extraFiles,
      });
      const head = repo.commit("fake fix");
      return { repo, base, head };
    }

    it("sanity: without input tampering the fake fix is never a PASS (advisory MI006 WARN)", () => {
      const { repo, base } = fakeFixRepo();
      const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } });
      expect(result.outputs.status).toBe("warn");
      expect(result.stdout).toContain("MI006_REGRESSION_TEST_NON_DISCRIMINATING");
      expect(result.code).toBe(0);
    });

    it.each([
      ["base-ref == head-ref (empty comparison)", (head: string) => ({ "base-ref": head, "head-ref": head })],
      ["red-green: false", () => ({ "red-green": "false" })],
      ["config-source: head with a weakened policy", () => ({ "config-source": "head" })],
      ["working-directory pointing elsewhere", () => ({ "working-directory": "test" })],
    ])("returns ERROR instead of PASS when the workflow sets %s", (_name, inputs) => {
      const { repo, base, head } = fakeFixRepo({ ".merge-integrity.yml": "version: 1\nredGreen:\n  enabled: false\n" });
      const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } }, inputs(head));
      expect(result.outputs.status, result.stdout).toBe("error");
      expect(result.code).toBe(2);
      expect(result.stdout).toContain("not permitted");
    });

    it("BLOCKs a PR that weakens the policy file, even though the base policy is applied", () => {
      // Clean test change plus a policy that would lower MI004 (blocking by default): only MI106 can block this PR.
      const { repo, base } = prRepo({
        "test/math.test.js": TEST.replace("expect(add(2, 3)).toBe(5);", "expect(add(2, 3)).toBe(5);\n    expect(add(1, 1)).toBe(2);"),
        ".merge-integrity.yml": "version: 1\nrules:\n  MI004_ASSERTION_WEAKENED: warn\n",
      });
      const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("MI106_POLICY_WEAKENED");
    });
  });

  describe("protected CI: high-confidence tampering blocks, uncertain evidence is advisory", () => {
    const source = (condition: string) =>
      `function add(a, b) {\n  return a + b;\n}\n\nfunction isAdult(age) {\n  return ${condition};\n}\n\nmodule.exports = { add, isAdult };\n`;
    const pr = (base: string) => ({ name: "pull_request", payload: { pull_request: { base: { sha: base } } } });

    /** A buggy base with one test, then a PR that fixes the boundary and adds `testChange` before the existing test. */
    const fixRepo = (baseCondition: string, testChange: string, basePolicy?: string) => {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({
        "test/math.test.js": TEST,
        "src/math.js": source(baseCondition),
        ...(basePolicy === undefined ? {} : { ".merge-integrity.yml": basePolicy }),
      });
      const base = repo.commit("buggy base");
      repo.git("checkout", "-q", "-b", "pr");
      repo.write({ "src/math.js": source("age >= 18"), "test/math.test.js": TEST.replace('  it("adds numbers"', `${testChange}\n\n  it("adds numbers"`) });
      repo.commit("fix boundary");
      return { repo, base };
    };
    const TABLE_TEST = '  it.each([[18], [19]])("treats %i as adult", (age) => {\n    expect(isAdult(age)).toBe(true);\n  });';
    const FAKE_TEST = '  it("treats 30 as adult", () => {\n    expect(isAdult(30)).toBe(true);\n  });';

    it("PASSes with exit 0 when a changed test is fully verified RED/GREEN (sanity)", () => {
      const { repo, base } = fixRepo("age > 18", '  it("treats 18 as adult", () => {\n    expect(isAdult(18)).toBe(true);\n  });');
      const result = runAction(repo, pr(base));
      expect(result.code).toBe(0);
      expect(result.outputs.status).toBe("pass");
    });

    it("reports a runtime-named changed test that cannot be verified (MI103) as an advisory warning: exit 0", () => {
      const { repo, base } = fixRepo("age > 18", TABLE_TEST);
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("::warning file=test/math.test.js,line=4,title=MI103_RED_GREEN_INCONCLUSIVE");
      expect(result.stdout).not.toContain("::error");
      expect(result.summary).toContain("MI103_RED_GREEN_INCONCLUSIVE");
      expect(result.code).toBe(0);
    });

    it("reports an import/setup incompatibility (MI103) as advisory: exit 0", () => {
      const repo = createRepo({ fixture: "jest-basic" }); // jest-basic's isAdult is already the fixed implementation
      repos.push(repo);
      const base = repo.git("rev-parse", "HEAD").trim();
      repo.git("checkout", "-q", "-b", "pr");
      repo.write({
        "src/double.js": "module.exports = { double: (x) => x * 2 };\n",
        "test/double.test.js": 'const { double } = require("../src/double");\n\ndescribe("double", () => {\n  it("doubles", () => {\n    expect(double(2)).toBe(4);\n  });\n});\n',
      });
      repo.commit("add a module with no base counterpart");
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("MI103_RED_GREEN_INCONCLUSIVE");
      expect(result.code).toBe(0);
    });

    it("reports a non-discriminating regression test (MI006) as advisory: exit 0", () => {
      const { repo, base } = fixRepo("age > 18", FAKE_TEST);
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("title=MI006_REGRESSION_TEST_NON_DISCRIMINATING");
      expect(result.stdout).not.toContain("::error");
      expect(result.code).toBe(0);
    });

    it("lets the base-branch owner make MI006 blocking: exit 1", () => {
      const { repo, base } = fixRepo("age > 18", FAKE_TEST, "version: 1\nrules:\n  MI006_REGRESSION_TEST_NON_DISCRIMINATING: block\n");
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("block");
      expect(result.code).toBe(1);
    });

    it("reports a removed assertion (MI003) as advisory: exit 0", () => {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({ "test/math.test.js": TEST.replace("expect(add(2, 3)).toBe(5);", "expect(add(2, 3)).toBe(5);\n    expect(add(1, 1)).toBe(2);") });
      const base = repo.commit("two assertions");
      repo.git("checkout", "-q", "-b", "pr");
      repo.write({ "test/math.test.js": TEST });
      repo.commit("drop an assertion");
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("title=MI003_ASSERTION_REMOVED");
      expect(result.code).toBe(0);
    });

    it("still BLOCKs a high-confidence weakened assertion (MI004): exit 1", () => {
      const { repo, base } = prRepo({ "test/math.test.js": TEST.replace("expect(add(2, 3)).toBe(5);", "expect(add(2, 3)).toBeDefined();") });
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("block");
      expect(result.stdout).toContain("title=MI004_ASSERTION_WEAKENED");
      expect(result.code).toBe(1);
    });

    it("still succeeds (exit 0) when only a mutation survivor is present", () => {
      const { repo, base } = fixRepo("age < 18", '  it("treats 40 as adult", () => {\n    expect(isAdult(40)).toBe(true);\n  });');
      const result = runAction(repo, pr(base), { mutation: "true" });
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("MI102_MUTATION_SURVIVED");
      expect(result.code).toBe(0);
    });

    // Base has a custom Jest testRegex the product cannot analyse; the PR changes a JS file that may hold tests.
    const discoveryRepo = (basePolicy?: string) => {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({
        "jest.config.js": 'module.exports = { testRegex: "(/test/.*|\\\\.check)\\\\.js$" };\n',
        ...(basePolicy === undefined ? {} : { ".merge-integrity.yml": basePolicy }),
      });
      const base = repo.commit("custom discovery");
      repo.git("checkout", "-q", "-b", "pr");
      repo.write({ "src/math.check.js": 'const { add } = require("./math");\n\nit("adds", () => {\n  expect(add(1, 1)).toBe(2);\n});\n' });
      repo.commit("add a file the custom discovery may treat as a test");
      return { repo, base };
    };

    it("reports unsupported custom test discovery (MI107) as advisory: exit 0", () => {
      const { repo, base } = discoveryRepo();
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.stdout).toContain("MI107_TEST_DISCOVERY_UNSUPPORTED");
      expect(result.summary).toContain("MI107_TEST_DISCOVERY_UNSUPPORTED");
      expect(result.code).toBe(0);
    });

    it("lets the base-branch owner make MI107 blocking, including on merge_group: exit 1", () => {
      const { repo, base } = discoveryRepo("version: 1\nrules:\n  MI107_TEST_DISCOVERY_UNSUPPORTED: block\n");
      const head = repo.git("rev-parse", "HEAD").trim();
      const result = runAction(repo, { name: "merge_group", payload: { merge_group: { base_sha: base, head_sha: head } } });
      expect(result.outputs.status, result.stdout).toBe("block");
      expect(result.code).toBe(1);
    });

    it("lets the base-branch owner fail on every warning with warningsBlockMerge: true: exit 1", () => {
      const { repo, base } = discoveryRepo("version: 1\npolicy:\n  warningsBlockMerge: true\n");
      const result = runAction(repo, pr(base));
      expect(result.outputs.status, result.stdout).toBe("warn");
      expect(result.code).toBe(1);
    });

    it("honours a base-branch ignore entry for MI107", () => {
      const { repo, base } = discoveryRepo(
        'version: 1\nignore:\n  - rule: MI107_TEST_DISCOVERY_UNSUPPORTED\n    path: jest.config.js\n    reason: "custom testRegex reviewed by the owner"\n',
      );
      const result = runAction(repo, pr(base));
      expect(result.summary).toContain("custom testRegex reviewed by the owner");
      expect(result.code, result.stdout).toBe(0);
    });

    it("cannot be dodged by a PR that disables red/green in the policy file: MI106 still BLOCKs", () => {
      const { repo, base } = fixRepo("age > 18", TABLE_TEST);
      repo.write({ ".merge-integrity.yml": "version: 1\nredGreen:\n  enabled: false\n" });
      repo.commit("also disable red/green in the policy");
      const result = runAction(repo, pr(base));
      expect(result.code).toBe(1);
      expect(result.outputs.status).toBe("block");
      expect(result.stdout).toContain("MI106_POLICY_WEAKENED");
    });
  });

  describe("compatibility preflight (mode: doctor)", () => {
    it("reports SUPPORTED on workflow_dispatch without failing the job", () => {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({ "test/math.test.js": TEST });
      repo.commit("tests");
      const result = runAction(repo, { name: "workflow_dispatch", payload: {} }, { mode: "doctor" });
      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout).toContain("Merge Integrity preflight: SUPPORTED");
      expect(result.outputs.status).toBe("supported");
      expect(result.summary).toContain("Merge Integrity preflight");
    });

    it("reports UNSUPPORTED for Yarn Plug'n'Play but still exits 0", () => {
      const repo = createRepo({ fixture: "jest-basic" });
      repos.push(repo);
      repo.write({ ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.12.0.cjs\n", "yarn.lock": "__metadata:\n  version: 8\n" });
      repo.commit("pnp");
      const result = runAction(repo, { name: "workflow_dispatch", payload: {} }, { mode: "doctor" });
      expect(result.code, result.stdout).toBe(0);
      expect(result.stdout).toContain("UNSUPPORTED");
      expect(result.outputs.status).toBe("unsupported");
    });

    it("refuses mode: doctor on a pull request (it would replace the gate with a no-op)", () => {
      const { repo, base } = prRepo({ "src/math.js": 'module.exports = { add: (a, b) => a + b, isAdult: (age) => age >= 18 };\n' });
      const result = runAction(repo, { name: "pull_request", payload: { pull_request: { base: { sha: base } } } }, { mode: "doctor" });
      expect(result.code).toBe(2);
      expect(result.outputs.status).toBe("error");
      expect(result.stdout).toContain("mode");
    });
  });
});
