import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isWithin } from "../fs/paths.js";

export interface ResolvedPackage {
  dir: string;
  version: string;
  /** Absolute path of the named bin script, when requested and present. */
  bin?: string;
}

/**
 * Find an installed package by walking `node_modules` directories from `startDir` up to `stopDir` (inclusive).
 * Resolution never leaves `stopDir`, so a global or parent install is not silently used.
 */
export async function findInstalledPackage(
  name: string,
  startDir: string,
  stopDir: string,
  binName?: string,
): Promise<ResolvedPackage | undefined> {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error(`invalid package name: ${name}`);
  let dir = resolve(startDir);
  const stop = resolve(stopDir);
  if (!isWithin(stop, dir)) return undefined;
  for (;;) {
    const pkgDir = join(dir, "node_modules", ...name.split("/"));
    const manifest = await readManifest(join(pkgDir, "package.json"));
    if (manifest) {
      const result: ResolvedPackage = { dir: pkgDir, version: typeof manifest.version === "string" ? manifest.version : "unknown" };
      if (binName !== undefined) {
        const bin = manifest.bin;
        const rel = typeof bin === "string" ? bin : bin && typeof bin === "object" ? (bin as Record<string, unknown>)[binName] : undefined;
        if (typeof rel === "string") {
          const binPath = resolve(pkgDir, rel);
          if (isWithin(pkgDir, binPath)) result.bin = binPath;
        }
      }
      return result;
    }
    if (dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
