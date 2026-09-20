import { isParsableSource } from "../ast/parse.js";

export type FileClass =
  | "test"
  | "test-support"
  | "snapshot"
  | "test-config"
  | "package-manifest"
  | "lockfile"
  | "docs"
  | "source"
  | "other";

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]);
const SUPPORT_SEGMENTS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__", "fixtures", "__helpers__", "test-utils", "testing"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_CONFIG = /^(jest\.config\.([cm]?[jt]s|json)|(vitest|vite)\.config\.[cm]?[jt]s|vitest\.workspace\.[cm]?[jt]s|vitest\.projects\.[cm]?[jt]s)$/i;
const SETUP_FILE = /^(setupTests|jest\.setup|vitest\.setup|test-setup|setup-tests)\.[cm]?[jt]sx?$/i;
const DOCS = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/**
 * Classify a path relative to the project working directory. Deterministic and purely name-based:
 * repository content never influences classification.
 */
export function classifyPath(relPath: string): FileClass {
  const segments = relPath.split("/");
  const base = segments.at(-1) ?? relPath;
  const dirs = segments.slice(0, -1);

  if (segments.length === 1) {
    if (base === "package.json") return "package-manifest";
    if (LOCKFILES.has(base)) return "lockfile";
    if (TEST_CONFIG.test(base)) return "test-config";
  }
  if (base.endsWith(".snap") || dirs.includes("__snapshots__")) return "snapshot";
  if (isParsableSource(relPath) && (TEST_FILE.test(base) || dirs.includes("__tests__"))) return "test";
  if (SETUP_FILE.test(base)) return "test-support";
  if (dirs.some((d) => SUPPORT_SEGMENTS.has(d))) return "test-support";
  if (DOCS.test(base) || /^(LICENSE|LICENCE|CHANGELOG|AUTHORS|NOTICE)(\.|$)/i.test(base)) return "docs";
  if (isParsableSource(relPath)) return "source";
  return "other";
}

/** Changes that alter behaviour the tests exercise (used to decide whether red/green verification applies). */
export function isImplementationClass(fileClass: FileClass): boolean {
  return fileClass === "source" || fileClass === "other" || fileClass === "package-manifest" || fileClass === "lockfile";
}
