import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustedToolEnv, untrustedEnv, isForbiddenPassthrough } from "../../src/process/env.js";
import { resolveExecutable } from "../../src/process/executable.js";
import { runProcess } from "../../src/process/run.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mi-env-")));
  dirs.push(dir);
  return dir;
}

const SECRETS = {
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_ACCESS_KEY_ID: "aws-id",
  DATABASE_URL: "postgres://user:pw@db/prod",
  OPENAI_API_KEY: "sk-fake",
  MY_ORG_DEPLOY_CREDENTIAL: "custom",
  GITHUB_TOKEN: "ghs_fake",
  ACTIONS_RUNTIME_TOKEN: "rt",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "idt",
  INPUT_CONFIG: "x",
  GITHUB_OUTPUT: "/tmp/out",
  GITHUB_ENV: "/tmp/env",
  GITHUB_STEP_SUMMARY: "/tmp/sum",
  NPM_TOKEN: "npm",
};

describe("untrustedEnv (allowlist)", () => {
  const source = { PATH: "/usr/bin", LANG: "C.UTF-8", TZ: "UTC", HOME: "/home/runner", ...SECRETS };

  it("passes only allowlisted variables and never arbitrary secrets", () => {
    const env = untrustedEnv({ source });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.CI).toBe("true");
    for (const key of Object.keys(SECRETS)) expect(env[key], key).toBeUndefined();
  });

  it("redirects home and temporary directories into a per-run sandbox", () => {
    const sandbox = temp();
    const env = untrustedEnv({ source, sandboxDir: sandbox });
    for (const key of ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
      expect(env[key]?.startsWith(sandbox), key).toBe(true);
    }
  });

  it("passes explicitly configured variables but never runner-privileged ones", () => {
    const env = untrustedEnv({ source, passthrough: ["DATABASE_URL", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"] });
    expect(env.DATABASE_URL).toBe("postgres://user:pw@db/prod");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    expect(isForbiddenPassthrough("GITHUB_OUTPUT")).toBe(true);
    expect(isForbiddenPassthrough("INPUT_X")).toBe(true);
    expect(isForbiddenPassthrough("DATABASE_URL")).toBe(false);
  });

  it("matches Windows variable names case-insensitively", () => {
    const env = untrustedEnv({ source: { Path: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", Aws_Secret_Access_Key: "x" }, platform: "win32" });
    expect(env.Path).toBe("C:\\bin");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.Aws_Secret_Access_Key).toBeUndefined();
  });

  it("is the default environment for spawned processes: fake secrets do not reach the child", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", `process.stdout.write(JSON.stringify(${JSON.stringify(Object.keys(SECRETS))}.filter((k) => process.env[k] !== undefined)))`],
        cwd: temp(),
        timeoutMs: 20_000,
      });
      expect(result.stdout).toBe("[]");
    } finally {
      for (const key of Object.keys(SECRETS)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("trustedToolEnv (Git)", () => {
  it("keeps ordinary configuration but strips Actions runtime tokens and step files", () => {
    const env = trustedToolEnv({ PATH: "/bin", HOME: "/home/u", GIT_CONFIG_GLOBAL: "/g", ...SECRETS });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", GIT_CONFIG_GLOBAL: "/g" });
    for (const key of ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "INPUT_CONFIG", "GITHUB_OUTPUT", "NPM_TOKEN"]) expect(env[key], key).toBeUndefined();
  });
});

describe("resolveExecutable", () => {
  const exe = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, process.platform === "win32" ? `${name}.exe` : name);
    writeFileSync(file, "");
    if (process.platform !== "win32") chmodSync(file, 0o755);
    return file;
  };

  it("returns the first absolute PATH match", () => {
    const root = temp();
    const first = exe(join(root, "a"), "node");
    exe(join(root, "b"), "node");
    expect(resolveExecutable("node", { PATH: [join(root, "a"), join(root, "b")].join(delimiter) })).toBe(first);
  });

  it("ignores relative and empty PATH entries (current-directory hijacking)", () => {
    const root = temp();
    const safe = exe(join(root, "safe"), "node");
    expect(resolveExecutable("node", { PATH: ["", ".", "bin", join(root, "safe")].join(delimiter) })).toBe(safe);
  });

  it("ignores PATH entries inside untrusted roots such as the repository", () => {
    const root = temp();
    exe(join(root, "repo", "node_modules", ".bin"), "node");
    const safe = exe(join(root, "tools"), "node");
    expect(
      resolveExecutable("node", { PATH: [join(root, "repo", "node_modules", ".bin"), join(root, "tools")].join(delimiter) }, [join(root, "repo")]),
    ).toBe(safe);
  });

  it("returns undefined when nothing is found", () => {
    expect(resolveExecutable("definitely-not-a-real-binary-mi", { PATH: temp() })).toBeUndefined();
  });

  it("rejects names that are paths", () => {
    expect(() => resolveExecutable("../node", { PATH: "/bin" })).toThrow();
  });
});
