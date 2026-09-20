import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isSafeRelativePath, normalizeRelativePath } from "../fs/paths.js";
import { GitError, git, gitOk } from "./git.js";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ChangedFile {
  status: ChangeStatus;
  /** Repository-relative POSIX path in head (or in base for deletions). */
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
}

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  path: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function findRepositoryRoot(cwd: string): Promise<string> {
  const result = await gitOk(["rev-parse", "--show-toplevel"], cwd, { timeoutMs: 30_000 });
  return realpath(resolve(result.stdout.trim()));
}

export async function isShallowRepository(repoRoot: string): Promise<boolean> {
  const result = await gitOk(["rev-parse", "--is-shallow-repository"], repoRoot, { timeoutMs: 30_000 });
  return result.stdout.trim() === "true";
}

/** Validate a user-supplied ref before it reaches Git. Option-like and control-character refs are rejected. */
export function isAcceptableRef(ref: string): boolean {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the purpose of this pattern
  return ref.length > 0 && ref.length <= 1024 && !ref.startsWith("-") && !/[\u0000-\u001f\u007f\s]/.test(ref);
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  if (!isAcceptableRef(ref)) return undefined;
  const result = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], repoRoot, {
    timeoutMs: 30_000,
  });
  const sha = result.stdout.trim();
  return result.exitCode === 0 && SHA.test(sha) ? sha : undefined;
}

/** The unique merge base of two commits; ambiguous (criss-cross) or missing merge bases are errors. */
export async function uniqueMergeBase(repoRoot: string, base: string, head: string): Promise<string> {
  const result = await git(["merge-base", "--all", base, head], repoRoot, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new GitError("no merge base exists between base and head; history may be missing", result);
  const bases = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (bases.length !== 1 || !SHA.test(bases[0] as string)) {
    throw new GitError(`ambiguous merge base (${bases.length} candidates)`, result);
  }
  return bases[0] as string;
}

const STATUS: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/** Parse `git diff --name-status -z` output. Exported for tests. */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++] ?? "";
    const status = STATUS[code.charAt(0)];
    if (!status) throw new GitError(`unexpected diff status ${JSON.stringify(code)}`);
    if (status === "renamed" || status === "copied") {
      const oldPath = fields[i++];
      const path = fields[i++];
      if (oldPath === undefined || path === undefined) throw new GitError("truncated rename record in diff output");
      files.push({ status, path, oldPath });
    } else {
      const path = fields[i++];
      if (path === undefined) throw new GitError("truncated record in diff output");
      files.push({ status, path });
    }
  }
  for (const file of files) {
    for (const p of [file.path, file.oldPath]) {
      if (p !== undefined && !isSafeRelativePath(p)) throw new GitError(`unsafe path in diff output: ${JSON.stringify(p)}`);
    }
  }
  return files;
}

export async function listChangedFiles(repoRoot: string, from: string, to: string): Promise<ChangedFile[]> {
  const result = await gitOk(
    ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", from, to, "--"],
    repoRoot,
  );
  return parseNameStatusZ(result.stdout);
}

export interface LineRange {
  start: number;
  end: number;
}

/** Parse unified-diff hunk headers into added/modified line ranges on the new side. Exported for tests. */
export function parseAddedRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

export async function addedLineRanges(repoRoot: string, from: string, to: string, path: string): Promise<LineRange[]> {
  const result = await gitOk(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", from, to, "--", path], repoRoot);
  return parseAddedRanges(result.stdout);
}

/** Look up a single path in a commit tree. Returns undefined when the path does not exist. */
export async function treeEntry(repoRoot: string, commit: string, path: string): Promise<TreeEntry | undefined> {
  if (!SHA.test(commit)) throw new GitError("treeEntry requires a resolved commit SHA");
  if (!isSafeRelativePath(path)) throw new GitError(`unsafe path: ${JSON.stringify(path)}`);
  const result = await gitOk(["ls-tree", "-l", "-z", "--full-tree", commit, "--", normalizeRelativePath(path)], repoRoot);
  for (const record of result.stdout.split("\0")) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    if (match[5] !== normalizeRelativePath(path)) continue;
    return {
      mode: match[1] as string,
      type: match[2] as string,
      object: match[3] as string,
      size: match[4] === "-" ? 0 : Number(match[4]),
      path: match[5] as string,
    };
  }
  return undefined;
}

/** Names directly inside a directory of a commit tree ("." for the root). */
export async function listTreeNames(repoRoot: string, commit: string, dir: string): Promise<string[]> {
  if (!SHA.test(commit)) throw new GitError("listTreeNames requires a resolved commit SHA");
  const normalized = normalizeRelativePath(dir);
  const spec = normalized === "." ? commit : `${commit}:${normalized}`;
  const result = await git(["ls-tree", "-z", "--name-only", spec], repoRoot);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

export class BlobTooLargeError extends GitError {}

export type BlobResult =
  | { kind: "file"; text: string; executable: boolean }
  | { kind: "missing" }
  | { kind: "not-a-file"; mode: string };

/**
 * Read a regular file from a commit without touching the working tree. Symlinks and submodules are reported,
 * never followed.
 */
export async function readBlob(repoRoot: string, commit: string, path: string, maxBytes: number): Promise<BlobResult> {
  const entry = await treeEntry(repoRoot, commit, path);
  if (!entry) return { kind: "missing" };
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    return { kind: "not-a-file", mode: entry.mode };
  }
  if (entry.size > maxBytes) throw new BlobTooLargeError(`${path} exceeds the ${maxBytes}-byte analysis limit`);
  const result = await gitOk(["cat-file", "blob", entry.object], repoRoot, { maxOutputBytes: maxBytes + 1 });
  return { kind: "file", text: result.stdout, executable: entry.mode === "100755" };
}
