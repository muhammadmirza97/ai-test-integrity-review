import { parse as parseYaml } from "yaml";
import type { Node, ObjectExpression } from "@babel/types";
import { parseSource } from "../ast/parse.js";
import type { Framework } from "../domain/config.js";

/**
 * Static compatibility analysis for the preflight (`merge-integrity doctor`).
 *
 * Every function here works on already-read file contents only: nothing is executed, no repository command is
 * run, and no repository regular expression is compiled. Conditions are only reported when the 50-PR calibration
 * ([CALIBRATION_RESULTS.md]) or the implementation shows they change the outcome; environment requirements that
 * cannot be known from the repository (a `TZ` set by the project's own CI, a build step that is not in a script,
 * tests that need a service) are deliberately *not* guessed. See docs/ALPHA_SUPPORT_MATRIX.md.
 */

export type CompatibilityLevel = "ok" | "warn" | "fail";

export interface CompatibilityFinding {
  id: string;
  level: CompatibilityLevel;
  /** What was found. */
  message: string;
  /** What the user can do about it. */
  remedy?: string;
}

/** Framework majors exercised by the fixtures and the 58-PR calibration corpus. */
export const VALIDATED_FRAMEWORK_VERSIONS = {
  jest: { min: 29, max: 30 },
  vitest: { min: 4, max: 5 },
} as const;

/* -------------------------------------------------------------------------- */
/* Package manager                                                             */
/* -------------------------------------------------------------------------- */

export type PackageManager = "npm" | "pnpm" | "yarn" | "unknown";
export type NodeLinker = "node-modules" | "pnp" | "pnpm";

export interface PackageManagerInputs {
  /** `packageManager` field of the root package.json, if any. */
  packageManagerField?: string | undefined;
  /** Contents of `.yarnrc.yml`, if present. */
  yarnrcYml?: string | undefined;
  /** First bytes of `yarn.lock`, if present. */
  yarnLock?: string | undefined;
  hasPnpmLock?: boolean;
  hasNpmLock?: boolean;
  /** `.pnp.cjs` or `.pnp.loader.mjs` exists. */
  hasPnpFile?: boolean;
}

export interface PackageManagerDetection {
  manager: PackageManager;
  /** Yarn only: the resolved installation strategy. */
  nodeLinker?: NodeLinker;
  /** True when dependencies are not installed into `node_modules`. */
  pnp: boolean;
  evidence: string[];
}

function yarnMajor(field: string | undefined): number | undefined {
  const match = /^yarn@(\d+)\./.exec((field ?? "").trim());
  return match ? Number(match[1]) : undefined;
}

function yarnrcNodeLinker(yarnrcYml: string | undefined): NodeLinker | undefined {
  if (yarnrcYml === undefined) return undefined;
  let value: unknown;
  try {
    value = parseYaml(yarnrcYml, { maxAliasCount: 100 });
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const linker = (value as Record<string, unknown>).nodeLinker;
  if (linker === "node-modules" || linker === "pnp" || linker === "pnpm") return linker;
  return undefined;
}

/**
 * Determine the package manager and, for Yarn, whether Plug'n'Play is in use. Yarn Berry (>= 2) installs with
 * Plug'n'Play unless `nodeLinker` says otherwise, and then there is no `node_modules` tree for the gate to resolve
 * Jest/Vitest from (calibration: toss/es-toolkit, 3 PRs, all ERROR).
 */
export function detectPackageManager(inputs: PackageManagerInputs): PackageManagerDetection {
  const evidence: string[] = [];
  const field = inputs.packageManagerField;
  const berryMajor = yarnMajor(field);
  const berryLock = inputs.yarnLock !== undefined && /__metadata:/.test(inputs.yarnLock);
  const hasYarn = inputs.yarnLock !== undefined || inputs.yarnrcYml !== undefined || (field ?? "").startsWith("yarn@");

  if (inputs.hasPnpFile === true) evidence.push(".pnp.cjs");
  if (field !== undefined) evidence.push(`package.json packageManager: ${field}`);
  if (inputs.yarnrcYml !== undefined) evidence.push(".yarnrc.yml");
  if (inputs.yarnLock !== undefined) evidence.push("yarn.lock");
  if (inputs.hasPnpmLock === true) evidence.push("pnpm-lock.yaml");
  if (inputs.hasNpmLock === true) evidence.push("package-lock.json");

  if (hasYarn) {
    const isBerry = (berryMajor !== undefined && berryMajor >= 2) || berryLock || inputs.yarnrcYml !== undefined;
    const declared = yarnrcNodeLinker(inputs.yarnrcYml);
    const nodeLinker: NodeLinker = isBerry ? (declared ?? "pnp") : "node-modules";
    return {
      manager: "yarn",
      nodeLinker,
      pnp: inputs.hasPnpFile === true || nodeLinker === "pnp",
      evidence,
    };
  }
  if (inputs.hasPnpFile === true) return { manager: "unknown", pnp: true, evidence };
  if (inputs.hasPnpmLock === true) return { manager: "pnpm", pnp: false, evidence };
  if (inputs.hasNpmLock === true) return { manager: "npm", pnp: false, evidence };
  if ((field ?? "").startsWith("pnpm@")) return { manager: "pnpm", pnp: false, evidence };
  if ((field ?? "").startsWith("npm@")) return { manager: "npm", pnp: false, evidence };
  return { manager: "unknown", pnp: false, evidence };
}

export function packageManagerFinding(
  detection: PackageManagerDetection,
  context: { frameworkInstalled?: boolean } = {},
): CompatibilityFinding {
  const evidence = detection.evidence.length > 0 ? ` (${detection.evidence.join(", ")})` : "";
  if (detection.pnp) {
    return {
      id: "package-manager",
      level: "fail",
      message: `Yarn Plug'n'Play is in use${evidence}; dependencies are not installed into node_modules, so the gate cannot resolve the project's test runner and every run would ERROR`,
      remedy:
        'set `nodeLinker: node-modules` in .yarnrc.yml (and re-run `yarn install`) if you want to use this alpha; Plug\'n\'Play is not supported yet',
    };
  }
  if (detection.manager === "unknown") {
    if (context.frameworkInstalled === true) {
      return { id: "package-manager", level: "ok", message: "dependencies are installed under node_modules (no lockfile or packageManager field to identify the package manager)" };
    }
    return {
      id: "package-manager",
      level: "warn",
      message: `no lockfile or packageManager field was found${evidence}; the gate never installs anything and needs dependencies under node_modules before it runs`,
      remedy: "commit a lockfile and install dependencies in the workflow before the Merge Integrity step",
    };
  }
  const linker = detection.manager === "yarn" ? ` (nodeLinker: ${detection.nodeLinker ?? "node-modules"})` : "";
  return { id: "package-manager", level: "ok", message: `${detection.manager}${linker}${evidence}` };
}

/* -------------------------------------------------------------------------- */
/* Vitest browser mode                                                         */
/* -------------------------------------------------------------------------- */

function objectProperties(node: Node): { key: string; value: Node }[] {
  if (node.type !== "ObjectExpression") return [];
  const out: { key: string; value: Node }[] = [];
  for (const prop of (node as ObjectExpression).properties) {
    if (prop.type !== "ObjectProperty" || prop.computed) continue;
    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : undefined;
    if (key !== undefined) out.push({ key, value: prop.value as Node });
  }
  return out;
}

/** True for `{ enabled: true, ... }`. Vitest treats a missing `enabled` as false unless `--browser` is passed. */
function browserEnabled(node: Node): boolean {
  for (const { key, value } of objectProperties(node)) {
    if (key === "enabled") return value.type === "BooleanLiteral" && value.value;
  }
  return false;
}

export interface BrowserModeDetection {
  enabled: boolean;
  /** Where the enabled browser configuration was found. */
  path?: string;
}

/**
 * Find an enabled Vitest browser-mode block anywhere in a config file, including inside `projects`/`workspace`
 * entries (calibration: axios/axios, 2 PRs, both ERROR). Parsing only; the config is never evaluated.
 */
export function detectVitestBrowserMode(configText: string, configPath: string): BrowserModeDetection {
  let ast;
  try {
    ast = parseSource(configText, configPath);
  } catch {
    return { enabled: false };
  }
  let found: string | undefined;
  const seen = new Set<Node>();
  const walk = (node: Node | null | undefined, trail: string): void => {
    if (found !== undefined || node === null || node === undefined || typeof node.type !== "string") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === "ObjectProperty" && !node.computed) {
      const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "StringLiteral" ? node.key.value : undefined;
      if (key === "browser" && browserEnabled(node.value as Node)) {
        found = trail === "" ? "browser" : `${trail}.browser`;
        return;
      }
      if (key !== undefined) {
        walk(node.value as Node, trail === "" ? key : `${trail}.${key}`);
        return;
      }
    }
    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object") walk(item as Node, trail);
      } else if (value && typeof value === "object" && typeof (value as Node).type === "string") {
        walk(value as Node, trail);
      }
    }
  };
  walk(ast as unknown as Node, "");
  return found === undefined ? { enabled: false } : { enabled: true, path: found };
}

export function browserModeFinding(detection: BrowserModeDetection, configPath: string): CompatibilityFinding {
  if (!detection.enabled) return { id: "vitest-browser-mode", level: "ok", message: "no enabled Vitest browser-mode configuration was found" };
  return {
    id: "vitest-browser-mode",
    level: "fail",
    message: `Vitest browser mode is enabled in ${configPath} (${detection.path}); browser-mode test files cannot be verified and produce ERROR`,
    remedy:
      "browser mode is not supported in this alpha. Move the gate to a project directory whose tests run in Node, or wait for browser-mode support before enforcing the check",
  };
}

/* -------------------------------------------------------------------------- */
/* Test invocation (`scripts.test`)                                            */
/* -------------------------------------------------------------------------- */

/** Flags that supply configuration the gate does not replay: it runs the framework binary with its own flags. */
const CONFIG_FLAGS = new Set([
  "--config",
  "-c",
  "--project",
  "--projects",
  "--preset",
  "--roots",
  "--testMatch",
  "--testRegex",
  "--testPathPattern",
  "--setupFilesAfterEnv",
  "--globalSetup",
  "--testEnvironment",
  "--environment",
  "--workspace",
  "--dir",
  "--globals",
]);

const OUTPUT_FLAGS = new Set(["--color", "--colors", "--no-color"]);

const RUNNER_PREFIXES = new Set(["npx", "pnpm", "yarn", "npm", "bun", "bunx", "cross-env", "dotenv", "node", "nyc", "c8", "exec", "run", "dlx", "--"]);

export interface TestScriptAnalysis {
  /** The script after following `npm run <name>` style indirection. */
  resolved?: string;
  /** Scripts followed to get there, in order. */
  chain: string[];
  invokesFramework: boolean;
  configFlags: string[];
  outputFlags: string[];
  environmentAssignments: string[];
  /** A command runs before the framework in the same script (typically a build). */
  precedingCommand?: string;
  /** The script does not invoke jest/vitest directly. */
  customRunner: boolean;
}

function splitSegments(script: string): string[] {
  return script
    .split(/&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (;;) {
    const match = pattern.exec(segment);
    if (match === null) break;
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function isFrameworkToken(token: string, framework: Framework): boolean {
  const base = token.replace(/\.(c|m)?js$/i, "").split(/[\\/]/).pop() ?? token;
  return base === framework;
}

/** Follow `npm run x` / `pnpm x` / `yarn x` indirection to the script that really runs the tests. */
function resolveScript(scripts: Record<string, string>, name: string, chain: string[]): string | undefined {
  if (chain.includes(name) || chain.length > 3) return undefined;
  const script = scripts[name];
  if (script === undefined) return undefined;
  chain.push(name);
  const segments = splitSegments(script);
  if (segments.length === 1) {
    const tokens = tokenize(segments[0] as string);
    const head = tokens[0];
    if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
      const rest = tokens.slice(1).filter((t) => t !== "run" && t !== "--if-present" && t !== "-s" && t !== "--silent");
      const target = rest[0];
      if (target !== undefined && scripts[target] !== undefined) {
        return resolveScript(scripts, target, chain) ?? script;
      }
    }
  }
  return script;
}

/** Analyse how the project starts its tests. The gate runs the framework binary directly, not this script. */
export function analyzeTestScript(scripts: Record<string, string>, framework: Framework): TestScriptAnalysis {
  const chain: string[] = [];
  const resolved = resolveScript(scripts, "test", chain);
  const analysis: TestScriptAnalysis = {
    ...(resolved === undefined ? {} : { resolved }),
    chain,
    invokesFramework: false,
    configFlags: [],
    outputFlags: [],
    environmentAssignments: [],
    customRunner: false,
  };
  if (resolved === undefined) {
    analysis.customRunner = true;
    return analysis;
  }

  const segments = splitSegments(resolved);
  segments.forEach((segment, index) => {
    const tokens = tokenize(segment);
    let position = 0;
    while (position < tokens.length) {
      const token = tokens[position] as string;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        analysis.environmentAssignments.push((token.split("=")[0] as string));
        position++;
        continue;
      }
      if (RUNNER_PREFIXES.has(token)) {
        if (token === "cross-env") {
          let next = position + 1;
          while (next < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[next] as string)) {
            analysis.environmentAssignments.push(((tokens[next] as string).split("=")[0] as string));
            next++;
          }
          position = next;
          continue;
        }
        position++;
        continue;
      }
      break;
    }
    const command = tokens[position];
    const invokes = command !== undefined && isFrameworkToken(command, framework);
    if (invokes) {
      analysis.invokesFramework = true;
      if (index > 0) analysis.precedingCommand ??= segments[index - 1] as string;
      for (const token of tokens.slice(position + 1)) {
        const flag = token.split("=")[0] as string;
        if (CONFIG_FLAGS.has(flag)) analysis.configFlags.push(flag);
        else if (OUTPUT_FLAGS.has(flag)) analysis.outputFlags.push(flag);
      }
    }
  });
  analysis.customRunner = !analysis.invokesFramework;
  return analysis;
}

export interface TestScriptContext {
  framework: Framework;
  /** A Jest/Vitest config file the gate itself can find (root config file, or `jest` in package.json). */
  hasDiscoverableConfig: boolean;
  /** A `pretest` script exists. */
  hasPretest: boolean;
}

/**
 * Turn the analysis into preflight findings. `--config` with no config the gate can discover is the only `fail`:
 * it is exactly the react-hook-form case (3 of 3 PRs ERROR) where Jest runs with a completely different
 * configuration than the project intends.
 */
export function testScriptFindings(analysis: TestScriptAnalysis, context: TestScriptContext): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  const script = analysis.resolved;
  const where = analysis.chain.length > 1 ? `scripts.${analysis.chain.join(" -> scripts.")}` : "scripts.test";

  if (script === undefined) {
    return [
      {
        id: "test-command",
        level: "warn",
        message: "package.json has no `test` script; the gate runs the installed test runner directly, which may not match how this project runs its tests",
      },
    ];
  }
  if (analysis.customRunner) {
    findings.push({
      id: "test-command",
      level: "warn",
      message: `${where} (${JSON.stringify(script)}) does not invoke ${context.framework} directly; the gate runs the installed ${context.framework} binary with its own flags, so a custom runner's setup is not applied`,
      remedy: `check that \`${context.framework}\` can run the project's test files on its own before enforcing the check`,
    });
  }
  const configFlags = [...new Set(analysis.configFlags)];
  if (configFlags.length > 0) {
    const blocking = !context.hasDiscoverableConfig && configFlags.some((f) => f === "--config" || f === "-c");
    findings.push({
      id: "test-configuration",
      level: blocking ? "fail" : "warn",
      message: blocking
        ? `${where} passes ${configFlags.join(", ")} and no ${context.framework} configuration file exists that the gate can find; it would run with default configuration and ERROR`
        : `${where} passes ${configFlags.join(", ")}; the gate runs ${context.framework} without those flags, so that configuration is not applied`,
      remedy: blocking
        ? `move the configuration to a root-level ${context.framework}.config.* file (or, for Jest, a "jest" field in package.json) so the runner picks it up without flags`
        : `confirm the project's tests still run when ${context.framework} is started without ${configFlags.join(", ")}`,
    });
  }
  const outputFlags = [...new Set(analysis.outputFlags)];
  if (outputFlags.length > 0) {
    findings.push({
      id: "test-output-flags",
      level: "warn",
      message: `${where} passes ${outputFlags.join(", ")}; the gate always runs with colour disabled, so snapshots that contain colour codes will not match and those tests report ERROR/inconclusive`,
      remedy: "regenerate colour-dependent snapshots without colour, or expect warnings on the tests that use them",
    });
  }
  const assignments = [...new Set(analysis.environmentAssignments)];
  if (assignments.length > 0) {
    findings.push({
      id: "test-environment",
      level: "warn",
      message: `${where} sets ${assignments.join(", ")} before running the tests; the gate starts the runner directly with a minimal environment, so those values are not applied`,
      remedy: `set these variables in the workflow job and list their names under \`testEnvironment.passthrough\` in .merge-integrity.yml`,
    });
  }
  if (analysis.precedingCommand !== undefined || context.hasPretest) {
    findings.push({
      id: "test-build-step",
      level: "warn",
      message:
        analysis.precedingCommand === undefined
          ? "a `pretest` script runs before the tests; red/green verification runs the tests in a clean worktree without running it"
          : `${where} runs ${JSON.stringify(analysis.precedingCommand)} before the tests; red/green verification runs them in a clean worktree without that step`,
      remedy: "tests that need a build or generated files cannot be verified; they are reported as MI103 (advisory warning), not as a failure",
    });
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Framework versions                                                          */
/* -------------------------------------------------------------------------- */

export function frameworkVersionFinding(framework: Framework, version: string | undefined): CompatibilityFinding {
  const range = VALIDATED_FRAMEWORK_VERSIONS[framework];
  const match = /^(\d+)\./.exec(version ?? "");
  const major = match ? Number(match[1]) : undefined;
  if (major === undefined) {
    return {
      id: "framework-version",
      level: "warn",
      message: `${framework} version could not be read; this alpha was validated with ${framework} ${range.min}.x-${range.max}.x`,
    };
  }
  if (major < range.min || major > range.max) {
    return {
      id: "framework-version",
      level: "warn",
      message: `${framework} ${version} is outside the versions validated in this alpha (${framework} ${range.min}.x-${range.max}.x); it may still work, but no evidence exists either way`,
      remedy: "run the gate on a pull request without enforcing it before making the check required",
    };
  }
  return { id: "framework-version", level: "ok", message: `${framework} ${version} is a validated version (${range.min}.x-${range.max}.x)` };
}
