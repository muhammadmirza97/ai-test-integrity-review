import { join } from "node:path";

/**
 * Environments for child processes.
 *
 * - `untrustedEnv` (allowlist) is used for everything that executes repository-controlled code: the project's
 *   tests, Stryker and the mutant enumerator. Only variables needed to run Node and the OS are passed, plus
 *   names explicitly listed in the base-branch policy (`testEnvironment.passthrough`).
 * - `trustedToolEnv` (denylist) is used only for Git, which needs the user's Git configuration
 *   (e.g. `safe.directory`) and never executes repository code in the ways Merge Integrity invokes it.
 */

const ALLOW_EXACT = [
  "PATH",
  "PATHEXT",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
];
const ALLOW_PREFIX = ["LC_"];

/** Variables that grant more privilege than an ordinary `run:` step, or that are well-known credentials. */
const FORBIDDEN_EXACT = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "GITHUB_OUTPUT",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
]);
const FORBIDDEN_PREFIX = ["ACTIONS_", "INPUT_"];

export function isForbiddenPassthrough(name: string): boolean {
  const upper = name.toUpperCase();
  return FORBIDDEN_EXACT.has(upper) || FORBIDDEN_PREFIX.some((p) => upper.startsWith(p));
}

export interface UntrustedEnvOptions {
  source?: NodeJS.ProcessEnv;
  /** Per-run directory; HOME, TMP and cache locations are redirected into it. */
  sandboxDir?: string;
  /** Extra variable names from the base-branch policy. */
  passthrough?: readonly string[];
  platform?: NodeJS.Platform;
}

export function untrustedEnv(options: UntrustedEnvOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const platform = options.platform ?? process.platform;
  const normalize = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const allowed = new Set(ALLOW_EXACT.map(normalize));
  const extra = new Set((options.passthrough ?? []).filter((n) => !isForbiddenPassthrough(n)).map(normalize));
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = normalize(key);
    const permitted =
      allowed.has(name) || extra.has(name) || ALLOW_PREFIX.some((p) => name.startsWith(normalize(p)));
    if (permitted && !isForbiddenPassthrough(key)) env[key] = value;
  }

  const redirects: Record<string, string> = options.sandboxDir
    ? {
        HOME: join(options.sandboxDir, "home"),
        USERPROFILE: join(options.sandboxDir, "home"),
        APPDATA: join(options.sandboxDir, "home", "AppData", "Roaming"),
        LOCALAPPDATA: join(options.sandboxDir, "home", "AppData", "Local"),
        XDG_CACHE_HOME: join(options.sandboxDir, "home", ".cache"),
        XDG_CONFIG_HOME: join(options.sandboxDir, "home", ".config"),
        TMPDIR: join(options.sandboxDir, "tmp"),
        TEMP: join(options.sandboxDir, "tmp"),
        TMP: join(options.sandboxDir, "tmp"),
      }
    : Object.fromEntries(
        ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"]
          .map((k) => [k, source[k]] as const)
          .filter((e): e is [string, string] => typeof e[1] === "string"),
      );
  Object.assign(env, redirects);
  env.CI = "true";
  return env;
}

/** Denylist environment for trusted tools (Git). */
export function trustedToolEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (isForbiddenPassthrough(key)) continue;
    env[key] = value;
  }
  return env;
}
