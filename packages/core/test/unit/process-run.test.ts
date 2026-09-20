import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "../../src/process/run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mi-proc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runProcess", () => {
  it("captures stdout, stderr and exit code", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      cwd: dir,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  it("passes arguments with shell metacharacters literally and never through a shell", async () => {
    const marker = join(dir, "pwned");
    const nasty = `"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')" & echo $(whoami) | \`id\` > x`;
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", nasty],
      cwd: dir,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(nasty);
    expect(existsSync(marker)).toBe(false);
  });

  it("times out, kills the process tree and reports timedOut", async () => {
    const pidFile = join(dir, "child.pid");
    const script = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const result = await runProcess({ command: process.execPath, args: ["-e", script], cwd: dir, timeoutMs: 1_500 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(isAlive(childPid)).toBe(false);
  });

  it("truncates oversized output instead of exhausting memory", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"],
      cwd: dir,
      timeoutMs: 20_000,
      maxOutputBytes: 1024,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(result.outputTruncated).toBe(true);
  });

  it("reports a spawn failure instead of throwing", async () => {
    const result = await runProcess({ command: join(dir, "does-not-exist"), args: [], cwd: dir, timeoutMs: 5_000 });
    expect(result.spawnError).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it("rejects a non-positive timeout", async () => {
    await expect(runProcess({ command: process.execPath, args: [], cwd: dir, timeoutMs: 0 })).rejects.toThrow(/timeout/);
  });

});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
