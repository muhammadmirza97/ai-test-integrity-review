import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_PATH, parseConfigText } from "../config/parse.js";
import type { Framework, FrameworkSetting } from "../domain/config.js";
import { detectFramework } from "../framework/detect.js";
import { discoverTestFiles } from "../framework/discovery.js";
import { filesystemReader } from "../framework/fs-reader.js";
import { findInstalledPackage } from "../framework/resolve.js";
import { isSafeRelativePath, normalizeRelativePath } from "../fs/paths.js";
import { git } from "../git/git.js";
import { checkCompatibility, SUPPORTED_VERSIONS } from "../mutation/stryker.js";
import {
  analyzeTestScript,
  browserModeFinding,
  detectPackageManager,
  detectVitestBrowserMode,
  frameworkVersionFinding,
  packageManagerFinding,
  testScriptFindings,
  type CompatibilityFinding,
  type CompatibilityLevel,
} from "./compatibility.js";

export type CheckLevel = CompatibilityLevel;

/** Overall preflight answer. Mirrors the labels in docs/ALPHA_SUPPORT_MATRIX.md. */
export type SupportVerdict = "supported" | "supported-with-warnings" | "unsupported";

export const VERDICT_LABEL: Record<SupportVerdict, string> = {
  supported: "SUPPORTED",
  "supported-with-warnings": "SUPPORTED WITH WARNINGS",
  unsupported: "UNSUPPORTED",
};

export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  message: string;
  /** What the user can do about a warn/fail. */
  remedy?: string;
}

export interface DoctorOptions {
  cwd: string;
  workingDirectory?: string;
  configPath?: string;
  framework?: FrameworkSetting;
  baseRef?: string;
  headRef?: string;
}

export interface DoctorReport {
  /** False only when the repository is UNSUPPORTED as configured. */
  ok: boolean;
  verdict: SupportVerdict;
  framework?: Framework;
  checks: DoctorCheck[];
}

export const MIN_NODE = { major: 22, minor: 18 };

export function isSupportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= MIN_NODE.minor;
  if (major === 23) return false;
  if (major === 24) return minor >= 11;
  return major > 24;
}

export function verdictFor(checks: readonly DoctorCheck[]): SupportVerdict {
  if (checks.some((c) => c.level === "fail")) return "unsupported";
  if (checks.some((c) => c.level === "warn")) return "supported-with-warnings";
  return "supported";
}

function report(checks: DoctorCheck[], framework?: Framework): DoctorReport {
  const verdict = verdictFor(checks);
  return { ok: verdict !== "unsupported", verdict, ...(framework === undefined ? {} : { framework }), checks };
}

const VITEST_CONFIG_FILES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vitest.workspace.ts",
  "vitest.workspace.js",
  "vitest.workspace.mjs",
  "vitest.projects.ts",
  "vitest.projects.js",
];

interface PackageJson {
  scripts?: Record<string, unknown>;
  workspaces?: unknown;
  packageManager?: unknown;
}

async function readPackageJson(read: (path: string) => Promise<string | undefined>, path: string): Promise<PackageJson | undefined> {
  const text = await read(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function stringScripts(pkg: PackageJson | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(pkg?.scripts ?? {})) if (typeof value === "string") out[name] = value;
  return out;
}

/**
 * Validate the environment and the repository's configuration without analysing a pull request, and without
 * running any repository code. Answers one question: would this repository work with the alpha as it is
 * configured today (SUPPORTED / SUPPORTED WITH WARNINGS / UNSUPPORTED), and if not, why and what can be done.
 *
 * Only conditions with implementation or calibration evidence are reported. Requirements that cannot be seen in
 * the repository — environment variables the project's own CI provides, services the tests need, generated files
 * that are not produced by a script — are out of reach for a static preflight and are listed in
 * docs/ALPHA_SUPPORT_MATRIX.md instead.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: CheckLevel, message: string, remedy?: string) =>
    checks.push({ id, level, message, ...(remedy === undefined ? {} : { remedy }) });
  const addFinding = (finding: CompatibilityFinding) => checks.push({ ...finding });

  add(
    "node",
    isSupportedNode(process.version) ? "ok" : "fail",
    `Node.js ${process.version} (${isSupportedNode(process.version) ? "supported" : "requires ^22.18.0 || >=24.11.0"})`,
    isSupportedNode(process.version) ? undefined : "use Node 22.18+ or 24.11+ (actions/setup-node with node-version: 24)",
  );

  const gitVersion = await git(["--version"], options.cwd, { timeoutMs: 30_000 });
  if (gitVersion.exitCode !== 0) {
    add("git", "fail", "Git is not available on PATH", "install Git and re-run");
    return report(checks);
  }
  add("git", "ok", gitVersion.stdout.trim());

  const top = await git(["rev-parse", "--show-toplevel"], options.cwd, { timeoutMs: 30_000 });
  if (top.exitCode !== 0) {
    add("repository", "fail", "not inside a Git repository", "run the preflight from inside the repository you want to check");
    return report(checks);
  }
  const repoRoot = resolve(top.stdout.trim());
  add("repository", "ok", "Git repository found");

  const shallow = await git(["rev-parse", "--is-shallow-repository"], repoRoot, { timeoutMs: 30_000 });
  if (shallow.stdout.trim() === "true") {
    add(
      "history",
      "fail",
      "repository is a shallow clone; the base revision cannot be read",
      "check out with full history (actions/checkout with fetch-depth: 0)",
    );
  } else {
    add("history", "ok", "full Git history available");
  }

  for (const [id, ref] of [
    ["base-ref", options.baseRef],
    ["head-ref", options.headRef],
  ] as const) {
    if (ref === undefined) continue;
    const resolved = ref.startsWith("-")
      ? undefined
      : await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], repoRoot, { timeoutMs: 30_000 });
    if (resolved && resolved.exitCode === 0) add(id, "ok", `${ref} resolves to ${resolved.stdout.trim().slice(0, 12)}`);
    else add(id, "fail", `${JSON.stringify(ref)} does not resolve to a commit`, "fetch the branch, or pass a revision that exists locally");
  }

  const configRel = options.configPath ?? DEFAULT_CONFIG_PATH;
  let frameworkSetting: FrameworkSetting = options.framework ?? "auto";
  let workingDirectory = options.workingDirectory;
  let mutationEnabled = false;
  if (!isSafeRelativePath(configRel)) {
    add("config", "fail", `config path ${JSON.stringify(configRel)} must be relative to the repository root`);
  } else {
    let text: string | undefined;
    try {
      text = await readFile(join(repoRoot, ...configRel.split("/")), "utf8");
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      add("config", "ok", `${configRel} not found; built-in defaults apply`);
    } else {
      const parsed = parseConfigText(text, configRel);
      if (parsed.ok) {
        add("config", "ok", `${configRel} is valid`);
        if (options.framework === undefined) frameworkSetting = parsed.config.framework;
        workingDirectory ??= parsed.config.workingDirectory;
        mutationEnabled = parsed.config.mutation.enabled;
      } else {
        add("config", "fail", `${configRel} is invalid: ${parsed.errors.join("; ")}`, "fix the listed keys; see docs/INSTALL.md");
      }
    }
  }

  const wdRel = workingDirectory ?? ".";
  if (!isSafeRelativePath(wdRel, { allowDot: true })) {
    add("working-directory", "fail", `working directory ${JSON.stringify(wdRel)} must be inside the repository`);
    return report(checks);
  }
  const normalizedWd = normalizeRelativePath(wdRel);
  const workDir = resolve(repoRoot, ...normalizedWd.split("/"));

  const rootFiles = filesystemReader(repoRoot);
  const projectFiles = filesystemReader(workDir);
  const rootPackage = await readPackageJson((p) => rootFiles.readText(p), "package.json");

  // How dependencies are installed (Yarn Plug'n'Play has no node_modules for the gate to resolve from).
  const [yarnrcYml, yarnLock] = await Promise.all([rootFiles.readText(".yarnrc.yml"), rootFiles.readText("yarn.lock")]);
  const [hasPnpCjs, hasPnpLoader, hasPnpmLock, hasNpmLock] = await Promise.all([
    rootFiles.exists(".pnp.cjs"),
    rootFiles.exists(".pnp.loader.mjs"),
    rootFiles.exists("pnpm-lock.yaml"),
    rootFiles.exists("package-lock.json"),
  ]);
  const packageManager = detectPackageManager({
    packageManagerField: typeof rootPackage?.packageManager === "string" ? rootPackage.packageManager : undefined,
    yarnrcYml,
    ...(yarnLock === undefined ? {} : { yarnLock: yarnLock.slice(0, 4096) }),
    hasPnpmLock,
    hasNpmLock,
    hasPnpFile: hasPnpCjs || hasPnpLoader,
  });

  // One project per repository is supported in protected CI; a workspace root needs `workingDirectory`.
  const hasPnpmWorkspace = await rootFiles.exists("pnpm-workspace.yaml");
  if (normalizedWd === "." && (rootPackage?.workspaces !== undefined || hasPnpmWorkspace)) {
    add(
      "workspaces",
      "warn",
      "this looks like a monorepo/workspace root; the gate analyses one project directory",
      'set `workingDirectory` in .merge-integrity.yml to the package whose tests should be verified',
    );
  }

  const detection = await detectFramework(projectFiles, frameworkSetting);
  if (detection.kind !== "jest" && detection.kind !== "vitest") {
    add(
      "framework",
      "fail",
      `${detection.kind}: ${"reason" in detection ? detection.reason : ""}`,
      detection.kind === "ambiguous"
        ? "set `framework: jest` or `framework: vitest` in .merge-integrity.yml"
        : "this alpha supports Jest and Vitest only",
    );
    return report(checks);
  }
  const framework: Framework = detection.kind;
  add("framework", "ok", `${framework} detected (${detection.evidence.join(", ")})`);

  const installed = await findInstalledPackage(framework, workDir, repoRoot);
  addFinding(packageManagerFinding(packageManager, { frameworkInstalled: installed !== undefined }));
  add(
    "dependencies",
    installed ? "ok" : "fail",
    installed ? `${framework} ${installed.version} is installed` : `${framework} is not installed under node_modules`,
    installed
      ? undefined
      : packageManager.pnp
        ? "Plug'n'Play does not create node_modules; see the package-manager check above"
        : "install dependencies (npm ci / pnpm install / yarn install) before the gate runs",
  );
  addFinding(frameworkVersionFinding(framework, installed?.version));

  // Test-file discovery: anything that cannot be read statically becomes MI107 (advisory warning) on every run.
  const discovery = await discoverTestFiles(projectFiles, framework);
  if (discovery.kind === "unsupported") {
    add(
      "test-discovery",
      "warn",
      `test discovery cannot be read statically: ${discovery.reason ?? "unknown"}${discovery.source === undefined ? "" : ` (${discovery.source})`}`,
      "every run will report MI107 (advisory warning) and only default test-file naming is analysed; use standard `*.test.*`/`*.spec.*` names or a static `testMatch`/`include` to remove it",
    );
  } else {
    add("test-discovery", "ok", `${discovery.kind} test-file discovery${discovery.source === undefined ? "" : ` (${discovery.source})`}`);
  }

  if (framework === "vitest") {
    const inspected: string[] = [];
    let browserFinding: CompatibilityFinding | undefined;
    for (const name of VITEST_CONFIG_FILES) {
      const text = await projectFiles.readText(name);
      if (text === undefined) continue;
      inspected.push(name);
      const browser = detectVitestBrowserMode(text, name);
      if (browser.enabled) {
        browserFinding = browserModeFinding(browser, name);
        break;
      }
    }
    if (browserFinding) addFinding(browserFinding);
    else if (inspected.length > 0) add("vitest-browser-mode", "ok", `browser mode is not enabled in ${inspected.join(", ")}`);
    else add("vitest-browser-mode", "ok", "no Vitest configuration file found; browser mode is not configured");
  }

  const projectPackage = normalizedWd === "." ? rootPackage : await readPackageJson((p) => projectFiles.readText(p), "package.json");
  const scripts = stringScripts(projectPackage);
  const hasDiscoverableConfig = detection.evidence.some((e) => e.startsWith("config file") || e.includes('"jest" field'));
  for (const finding of testScriptFindings(analyzeTestScript(scripts, framework), {
    framework,
    hasDiscoverableConfig,
    hasPretest: typeof scripts.pretest === "string",
  })) {
    addFinding(finding);
  }

  const core = await findInstalledPackage("@stryker-mutator/core", workDir, repoRoot);
  const runnerName = `@stryker-mutator/${framework}-runner`;
  const runner = await findInstalledPackage(runnerName, workDir, repoRoot);
  const range = SUPPORTED_VERSIONS[framework];
  const howTo =
    `mutation testing is optional (mutation.enabled: true in .merge-integrity.yml). It requires @stryker-mutator/core@${SUPPORTED_VERSIONS.strykerCore.min} ` +
    `and ${runnerName}@${SUPPORTED_VERSIONS.strykerCore.min} with ${framework} ${range.min}.x-${range.max}.x`;
  if (core && runner) {
    const incompatible = checkCompatibility(core.version, framework, installed?.version);
    if (incompatible) add("stryker", mutationEnabled ? "fail" : "warn", `${incompatible}; ${howTo}`, "set mutation.enabled: false, or install the supported versions");
    else
      add(
        "stryker",
        "ok",
        `@stryker-mutator/core ${core.version} and ${runnerName} ${runner.version} are installed; mutation testing is ${mutationEnabled ? "enabled" : "available but disabled"}`,
      );
  } else {
    const missing = [core ? undefined : "@stryker-mutator/core", runner ? undefined : runnerName].filter(Boolean).join(", ");
    if (mutationEnabled) add("stryker", "fail", `${missing} not installed but mutation testing is enabled (it would ERROR); ${howTo}`, "install Stryker, or set mutation.enabled: false");
    else add("stryker", "ok", `mutation testing is disabled; ${howTo}`);
  }

  return report(checks, framework);
}
