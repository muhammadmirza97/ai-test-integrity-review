import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_REPOS = join(REPO_ROOT, "test-repos");

export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  write(files: Record<string, string | null>): void;
  commit(message: string): string;
  cleanup(): void;
}

function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Link a directory without requiring elevated privileges on Windows. */
export function linkDirectory(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function removeLink(path: string): void {
  try {
    if (!lstatSync(path).isSymbolicLink()) return;
  } catch {
    return;
  }
  if (process.platform === "win32") rmdirSync(path);
  else unlinkSync(path);
}

/**
 * Create a temporary Git repository from a fixture template (without node_modules),
 * commit it as the base, and link the fixture's installed node_modules.
 */
export function createRepo(options: { fixture?: string; subdir?: string; linkNodeModules?: boolean } = {}): TempRepo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mi-repo-")));
  const projectDir = options.subdir ? join(dir, ...options.subdir.split("/")) : dir;
  gitIn(dir, ["init", "-q", "-b", "main"]);
  gitIn(dir, ["config", "user.name", "Merge Integrity Tests"]);
  gitIn(dir, ["config", "user.email", "tests@example.invalid"]);
  gitIn(dir, ["config", "core.autocrlf", "false"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");

  if (options.fixture) {
    const source = join(TEST_REPOS, options.fixture);
    cpSync(source, projectDir, {
      recursive: true,
      filter: (src) => !src.includes(`${join(source, "node_modules")}`) && !src.endsWith("package-lock.json"),
    });
    const modules = join(source, "node_modules");
    if (options.linkNodeModules !== false && existsSync(modules)) linkDirectory(modules, join(projectDir, "node_modules"));
  }

  const repo: TempRepo = {
    dir,
    git: (...args) => gitIn(dir, args),
    write(files) {
      for (const [rel, content] of Object.entries(files)) {
        const path = join(dir, ...rel.split("/"));
        if (content === null) {
          rmSync(path, { force: true });
        } else {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        }
      }
    },
    commit(message) {
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "--allow-empty", "-m", message]);
      return gitIn(dir, ["rev-parse", "HEAD"]).trim();
    },
    cleanup() {
      removeLink(join(projectDir, "node_modules"));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  repo.commit("base");
  return repo;
}
