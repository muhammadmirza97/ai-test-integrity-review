// Installs the fixture repositories' own dependencies (Jest/Vitest/Stryker) from their lockfiles.
// Install scripts are disabled: fixtures only need the packages' JavaScript.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const fixtures = ["jest-basic", "vitest-basic", "vitest5-basic"];
const [command, prefix] = process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm"]] : ["npm", []];
for (const name of fixtures) {
  const dir = join(import.meta.dirname, "..", "test-repos", name);
  const args = existsSync(join(dir, "package-lock.json"))
    ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  console.log(`> npm ${args.join(" ")} (${name})`);
  const result = spawnSync(command, [...prefix, ...args], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
