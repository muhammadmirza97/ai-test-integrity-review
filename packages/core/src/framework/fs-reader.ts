import { lstat, readFile } from "node:fs/promises";
import type { ProjectFileReader } from "./detect.js";
import { resolveContainedPath } from "../fs/paths.js";

const MAX_BYTES = 2 * 1024 * 1024;

/** Reads regular files under a directory; symlinks and oversized files are treated as absent. */
export function filesystemReader(root: string): ProjectFileReader {
  const stats = async (rel: string) => {
    try {
      const path = await resolveContainedPath(root, rel);
      const info = await lstat(path);
      return info.isFile() ? { path, size: info.size } : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async exists(rel) {
      return (await stats(rel)) !== undefined;
    },
    async readText(rel) {
      const info = await stats(rel);
      if (!info || info.size > MAX_BYTES) return undefined;
      return readFile(info.path, "utf8");
    },
  };
}
