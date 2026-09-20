import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { createRepo, type TempRepo } from "../../../../test-support/repo.js";

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()?.cleanup();
});

async function cli(args: string[], cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, { cwd, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe("merge-integrity CLI", () => {
  it("prints help", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("merge-integrity <command>");
    expect(result.stdout).toContain("check");
    expect(result.stdout).toContain("doctor");
  });

  it("fails with usage when no command is given", async () => {
    const result = await cli([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage");
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    expect((await cli(["frobnicate"])).code).toBe(2);
    expect((await cli(["check", "--ignore-everything"])).code).toBe(2);
    expect((await cli(["check", "--framework", "mocha"])).code).toBe(2);
    expect((await cli(["check", "--config-source", "pr"])).code).toBe(2);
  });

  it("doctor detects a simple Jest fixture and reports SUPPORTED", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    const result = await cli(["doctor"], repo.dir);
    expect(result.stdout).toContain("Merge Integrity preflight: SUPPORTED");
    expect(result.stdout).toContain("[ok  ] framework: jest detected");
    expect(result.stdout).toMatch(/\[ok {2}\] dependencies: jest \d+/);
    expect(result.stdout).toContain("[ok  ] stryker:");
    expect(result.code).toBe(0);
  });

  it("doctor detects a simple Vitest fixture", async () => {
    const repo = createRepo({ fixture: "vitest-basic" });
    repos.push(repo);
    const result = await cli(["doctor"], repo.dir);
    expect(result.stdout).toContain("[ok  ] framework: vitest detected");
    expect(result.stdout).toMatch(/\[ok {2}\] dependencies: vitest \d+/);
    expect(result.stdout).toContain("[ok  ] vitest-browser-mode:");
    expect(result.code).toBe(0);
  });

  it("doctor emits JSON with a verdict", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    const result = await cli(["doctor", "--format", "json"], repo.dir);
    const report = JSON.parse(result.stdout) as { verdict: string; ok: boolean; framework: string; checks: { id: string }[] };
    expect(report.verdict).toBe("supported");
    expect(report.ok).toBe(true);
    expect(report.framework).toBe("jest");
    expect(report.checks.map((c) => c.id)).toContain("package-manager");
    expect(result.code).toBe(0);
  });

  it("doctor reports an unsupported fixture explicitly", async () => {
    const repo = createRepo({ fixture: "unsupported-basic" });
    repos.push(repo);
    const result = await cli(["doctor"], repo.dir);
    expect(result.stdout).toContain("Merge Integrity preflight: UNSUPPORTED");
    expect(result.stdout).toContain("[fail] framework: unsupported");
    expect(result.stdout).toContain("not a claim that the repository is wrong");
    expect(result.code).toBe(2);
  });

  it("doctor reports invalid configuration and unresolvable refs", async () => {
    const repo = createRepo({ fixture: "jest-basic" });
    repos.push(repo);
    repo.write({ ".merge-integrity.yml": "version: 1\nrules:\n  MI001_TEST_SKIPPED: off\n" });
    const result = await cli(["doctor", "--base", "does-not-exist", "--head=--upload-pack=evil"], repo.dir);
    expect(result.stdout).toContain("[fail] config");
    expect(result.stdout).toContain("[fail] base-ref");
    expect(result.stdout).toContain("[fail] head-ref");
    expect(result.code).toBe(2);
  });

  it("doctor fails outside a Git repository", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mi-nogit-"));
    try {
      const result = await cli(["doctor"], dir);
      expect(result.code).toBe(2);
      expect(result.stdout).toContain("[fail] repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
