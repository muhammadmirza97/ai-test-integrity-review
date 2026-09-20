import { lstatSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveContainedPath } from "../fs/paths.js";
import { gitOk, git } from "../git/git.js";
import { readBlob } from "../git/repository.js";

const MAX_OVERLAY_BYTES = 10 * 1024 * 1024;

/** Top-level node_modules directories that are per-run tool caches and must not be shared between runs. */
const TOOL_CACHE_DIRS = new Set([".cache", ".vite", ".vite-temp", ".vitest", ".stryker-tmp"]);

export interface Worktree {
  label: string;
  commit: string;
  root: string;
  /** Project directory inside the worktree (root + working directory). */
  projectDir: string;
}

export interface RunSandbox {
  /** Private directory for this execution: HOME, TMP, caches and reports live here. */
  dir: string;
  scratch: string;
}

export class DependencyTamperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyTamperError";
  }
}

/** Live workspaces, so a signal handler can remove them if the process is interrupted. */
const liveWorkspaces = new Set<Workspace>();

interface EntryState {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: number;
}

/**
 * Temporary Git worktrees for isolated test execution.
 *
 * Every execution (head run, base run, overlay run, confirmation run, mutation run) gets a FRESH worktree and a
 * fresh sandbox (HOME/TMP/caches), created from the commit and disposed afterwards, so no run can see files an
 * earlier run created. The installed dependencies are shared read-only by convention; a metadata fingerprint
 * (inode, size, mtime and ctime — ctime cannot be forged by unprivileged processes) is taken before the first
 * run and verified after each run, and any modification is a DependencyTamperError (ERROR).
 * The user's working tree is never checked out or modified.
 */
export class Workspace {
  private tempRoot: string | undefined;
  private readonly worktrees = new Set<Worktree>();
  private readonly links = new Map<Worktree, string[]>();
  private counter = 0;
  private cleaned = false;
  private dependencyFingerprint: Map<string, EntryState> | undefined;

  constructor(
    readonly repoRoot: string,
    readonly workingDirectory: string,
  ) {}

  async root(): Promise<string> {
    if (this.cleaned) throw new Error("workspace already cleaned up");
    if (!this.tempRoot) {
      this.tempRoot = await realpath(await mkdtemp(join(tmpdir(), "merge-integrity-")));
      await mkdir(join(this.tempRoot, "hooks"));
      liveWorkspaces.add(this);
    }
    return this.tempRoot;
  }

  /** Backwards-compatible alias used by stages for non-execution scratch files. */
  async scratchDir(): Promise<string> {
    const root = await this.root();
    await mkdir(join(root, "scratch"), { recursive: true });
    return root;
  }

  get rootPath(): string | undefined {
    return this.tempRoot;
  }

  /** Directories that must never be trusted as PATH entries for executables. */
  untrustedRoots(): string[] {
    return [this.repoRoot, ...(this.tempRoot ? [this.tempRoot] : [])];
  }

  async newSandbox(): Promise<RunSandbox> {
    const root = await this.root();
    const dir = join(root, `run-${++this.counter}`);
    for (const sub of ["home/AppData/Roaming", "home/AppData/Local", "home/.cache", "home/.config", "tmp", "scratch"]) {
      await mkdir(join(dir, ...sub.split("/")), { recursive: true });
    }
    return { dir, scratch: join(dir, "scratch") };
  }

  /** Create a fresh worktree for exactly one execution. Dispose it with `disposeWorktree`. */
  async freshWorktree(label: "base" | "head", commit: string): Promise<Worktree> {
    const temp = await this.root();
    const root = join(temp, `${label}-${++this.counter}`);
    // An empty hooks directory prevents repository or user hooks (e.g. post-checkout) from running.
    await gitOk(["-c", `core.hooksPath=${join(temp, "hooks")}`, "worktree", "add", "--detach", "--quiet", root, commit], this.repoRoot, {
      timeoutMs: 300_000,
    });
    const real = await realpath(root);
    const worktree: Worktree = {
      label,
      commit,
      root: real,
      projectDir: resolve(real, ...this.workingDirectory.split("/").filter((s) => s !== ".")),
    };
    this.worktrees.add(worktree);
    await this.linkNodeModules(worktree);
    await this.snapshotDependencies();
    return worktree;
  }

  private dependencySources(): string[] {
    const segments = this.workingDirectory === "." ? [] : this.workingDirectory.split("/");
    const sources: string[] = [];
    for (let depth = 0; depth <= segments.length; depth++) sources.push(join(this.repoRoot, ...segments.slice(0, depth), "node_modules"));
    return sources;
  }

  /**
   * Reuse the installed dependencies of the checked-out repository in the worktree.
   * Dependencies are therefore identical in base and head runs, so a difference in results is attributable to code.
   */
  private async linkNodeModules(worktree: Worktree): Promise<void> {
    const segments = this.workingDirectory === "." ? [] : this.workingDirectory.split("/");
    const created: string[] = [];
    this.links.set(worktree, created);
    for (let depth = 0; depth <= segments.length; depth++) {
      const rel = segments.slice(0, depth);
      let sourceReal: string;
      try {
        sourceReal = await realpath(join(this.repoRoot, ...rel, "node_modules"));
      } catch {
        continue;
      }
      const target = join(worktree.root, ...rel, "node_modules");
      try {
        await lstat(target);
        continue; // committed node_modules or an existing entry: leave it alone
      } catch {
        // target absent
      }
      // A real, disposable node_modules directory per worktree whose entries link to the installed packages.
      // Tools that create top-level entries (e.g. Vite's `.vite-temp`, `.cache`) write into the worktree, not into
      // the shared install; writes inside installed packages are caught by `verifyDependencies`.
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(sourceReal, { withFileTypes: true })) {
        if (TOOL_CACHE_DIRS.has(entry.name)) continue; // recreated per worktree by the tools that use them
        const from = join(sourceReal, entry.name);
        const to = join(target, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          let isDir = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              isDir = (await stat(from)).isDirectory();
            } catch {
              continue; // dangling link
            }
          }
          if (isDir) {
            await symlink(await realpath(from), to, process.platform === "win32" ? "junction" : "dir");
            created.push(to);
            continue;
          }
        }
        if (entry.isFile() || entry.isSymbolicLink()) await copyFile(from, to);
      }
    }
  }

  private async fingerprint(): Promise<Map<string, EntryState>> {
    const states = new Map<string, EntryState>();
    const visit = async (path: string): Promise<void> => {
      let info;
      try {
        info = await lstat(path, { bigint: true });
      } catch {
        return;
      }
      states.set(path, { ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs, mode: Number(info.mode) });
      if (!info.isDirectory()) return;
      let names: string[];
      try {
        names = await readdir(path);
      } catch {
        return;
      }
      for (const name of names) await visit(join(path, name));
    };
    for (const source of this.dependencySources()) {
      let real: string;
      try {
        real = await realpath(source);
      } catch {
        continue;
      }
      await visit(real);
    }
    return states;
  }

  private async snapshotDependencies(): Promise<void> {
    if (!this.dependencyFingerprint) this.dependencyFingerprint = await this.fingerprint();
  }

  /** Throw DependencyTamperError if any installed dependency entry was created, removed or modified. */
  async verifyDependencies(): Promise<void> {
    if (!this.dependencyFingerprint) return;
    const current = await this.fingerprint();
    const changes: string[] = [];
    for (const [path, before] of this.dependencyFingerprint) {
      const after = current.get(path);
      if (!after) changes.push(`removed ${path}`);
      else if (after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.mode !== before.mode) {
        changes.push(`modified ${path}`);
      }
      if (changes.length >= 5) break;
    }
    if (changes.length < 5) {
      for (const path of current.keys()) {
        if (!this.dependencyFingerprint.has(path)) changes.push(`added ${path}`);
        if (changes.length >= 5) break;
      }
    }
    if (changes.length > 0) {
      throw new DependencyTamperError(
        `installed dependencies were modified during a test run, so results cannot be trusted (${changes.slice(0, 3).join("; ")})`,
      );
    }
  }

  /** Write a file from a commit into a worktree, refusing traversal and symlinked parents. */
  async overlayFromCommit(worktree: Worktree, commit: string, repoRelPath: string): Promise<void> {
    const blob = await readBlob(this.repoRoot, commit, repoRelPath, MAX_OVERLAY_BYTES);
    const target = await resolveContainedPath(worktree.root, repoRelPath);
    if (blob.kind === "missing") return;
    if (blob.kind === "not-a-file") throw new Error(`${repoRelPath} is not a regular file and cannot be overlaid`);
    await mkdir(dirname(target), { recursive: true });
    const verified = await resolveContainedPath(worktree.root, repoRelPath);
    try {
      if ((await lstat(verified)).isSymbolicLink()) await unlink(verified);
    } catch {
      // does not exist yet
    }
    await writeFile(verified, blob.text);
  }

  private async unlinkDependencies(worktree: Worktree): Promise<string[]> {
    const errors: string[] = [];
    for (const link of this.links.get(worktree) ?? []) {
      try {
        if ((await lstat(link)).isSymbolicLink()) {
          if (process.platform === "win32") await rmdir(link);
          else await unlink(link);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`unlink ${link}: ${(error as Error).message}`);
      }
    }
    this.links.delete(worktree);
    return errors;
  }

  /** Remove one worktree completely. Dependency links are removed first; deletion aborts if that fails. */
  async disposeWorktree(worktree: Worktree): Promise<void> {
    if (!this.worktrees.has(worktree)) return;
    const errors = await this.unlinkDependencies(worktree);
    if (errors.length > 0) {
      throw new Error(`worktree cleanup aborted (dependency link still present): ${errors.join("; ")}`);
    }
    this.worktrees.delete(worktree);
    const result = await git(["worktree", "remove", "--force", "--force", worktree.root], this.repoRoot, { timeoutMs: 120_000 });
    await rm(worktree.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (result.exitCode !== 0) {
      await git(["worktree", "prune"], this.repoRoot, { timeoutMs: 60_000 });
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    liveWorkspaces.delete(this);
    const errors: string[] = [];
    for (const worktree of [...this.worktrees]) errors.push(...(await this.unlinkDependencies(worktree)));
    if (errors.length > 0) {
      // Never recursively delete a tree that may still contain a link to the real dependencies.
      throw new Error(`workspace cleanup aborted: ${errors.join("; ")}; remove ${this.tempRoot ?? "(unknown)"} manually`);
    }
    for (const worktree of [...this.worktrees]) {
      const result = await git(["worktree", "remove", "--force", "--force", worktree.root], this.repoRoot, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) errors.push(`git worktree remove ${worktree.label}: ${result.stderr.trim()}`);
      this.worktrees.delete(worktree);
    }
    if (this.tempRoot) {
      try {
        await rm(this.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        errors.push(`remove ${this.tempRoot}: ${(error as Error).message}`);
      }
    }
    await git(["worktree", "prune"], this.repoRoot, { timeoutMs: 60_000 });
    if (errors.length > 0) throw new Error(`workspace cleanup incomplete: ${errors.join("; ")}`);
  }

  /** Synchronous best-effort cleanup for signal handlers. */
  cleanupSync(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    liveWorkspaces.delete(this);
    for (const links of this.links.values()) {
      for (const link of links) {
        try {
          if (lstatSync(link).isSymbolicLink()) {
            if (process.platform === "win32") rmdirSync(link);
            else unlinkSync(link);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
        }
      }
    }
    if (this.tempRoot) {
      try {
        rmSync(this.tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

let handlersInstalled = false;

/** Remove live workspaces when the process is interrupted (e.g. a cancelled CI job). */
export function installInterruptCleanup(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      for (const workspace of [...liveWorkspaces]) workspace.cleanupSync();
      process.exit(2);
    });
  }
}

export function liveWorkspaceCount(): number {
  return liveWorkspaces.size;
}
