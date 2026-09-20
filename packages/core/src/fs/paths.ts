import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * True when `value` is a repository-relative path that cannot escape its root:
 * no absolute paths, drive letters, NUL bytes, backslashes, or `..` segments.
 */
export function isSafeRelativePath(value: string, options: { allowDot?: boolean } = {}): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "..") return false;
  }
  if (value === "." || value === "./") return options.allowDot === true;
  return true;
}

/** Normalise a safe relative path to a canonical posix form ("." for the root). */
export function normalizeRelativePath(value: string): string {
  const parts = value.split("/").filter((p) => p !== "" && p !== ".");
  return parts.length === 0 ? "." : parts.join("/");
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolve a repository-relative path under `root` for writing.
 * Rejects traversal and any existing symlink/junction component between root and the target,
 * so a checked-out symlink cannot redirect a write outside the root.
 */
export async function resolveContainedPath(root: string, relPath: string): Promise<string> {
  if (!isSafeRelativePath(relPath)) throw new UnsafePathError(`unsafe path: ${JSON.stringify(relPath)}`);
  const realRoot = await realpath(root);
  const target = resolve(realRoot, ...relPath.split("/"));
  if (!isWithin(realRoot, target) || target === realRoot) {
    throw new UnsafePathError(`path escapes root: ${JSON.stringify(relPath)}`);
  }
  let current = realRoot;
  for (const segment of relative(realRoot, target).split(sep)) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new UnsafePathError(`path traverses a symbolic link: ${JSON.stringify(relPath)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}
