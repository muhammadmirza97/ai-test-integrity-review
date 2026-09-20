import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isWithin } from "../fs/paths.js";

/**
 * Resolve a program name to an absolute path using PATH, without a shell.
 *
 * Relative and empty PATH entries are ignored (on Windows, process creation would otherwise also search the
 * working directory, which is repository-controlled), as are entries inside `untrustedRoots`
 * (repository checkouts and temporary worktrees).
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  untrustedRoots: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid executable name: ${name}`);
  const pathValue = Object.entries(env).find(([k]) => (platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH"))?.[1] ?? "";
  const roots = untrustedRoots.map((r) => resolve(r));
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const dir = resolve(entry);
    if (roots.some((root) => isWithin(root, dir))) continue;
    const candidate = join(dir, platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name);
    try {
      if (!statSync(candidate).isFile()) continue;
      if (platform !== "win32") accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not present or not executable
    }
  }
  return undefined;
}

export class ExecutableNotFoundError extends Error {
  constructor(name: string) {
    super(`"${name}" was not found on PATH (relative PATH entries and repository directories are ignored)`);
    this.name = "ExecutableNotFoundError";
  }
}

export function requireExecutable(name: string, env?: NodeJS.ProcessEnv, untrustedRoots?: readonly string[]): string {
  const found = resolveExecutable(name, env, untrustedRoots);
  if (!found) throw new ExecutableNotFoundError(name);
  return found;
}
