import { parseDocument } from "yaml";
import type { FrameworkSetting, IgnoreEntry, MergeIntegrityConfig } from "../domain/config.js";
import { RULES, RULE_IDS, isRuleId, type RuleId, type Severity } from "../domain/finding.js";
import { isSafeRelativePath } from "../fs/paths.js";
import { isForbiddenPassthrough } from "../process/env.js";

export const DEFAULT_CONFIG_PATH = ".merge-integrity.yml";
export const MAX_CONFIG_BYTES = 256 * 1024;

export const DEFAULT_CONFIG: MergeIntegrityConfig = Object.freeze({
  version: 1,
  workingDirectory: ".",
  framework: "auto",
  policy: { warningsBlockMerge: false },
  redGreen: { enabled: true, timeoutSeconds: 120 },
  // Mutation testing is opt-in: it requires Stryker in the project and a validated runner version.
  mutation: { enabled: false, timeoutSeconds: 180, maxMutants: 25 },
  testEnvironment: { passthrough: [] },
  rules: Object.fromEntries(RULE_IDS.map((id) => [id, RULES[id].defaultSeverity])) as Record<RuleId, Severity>,
  ignore: [],
}) as MergeIntegrityConfig;

export type ConfigParseResult = { ok: true; config: MergeIntegrityConfig } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Obj, allowed: readonly string[], where: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
  }
}

function readBoolean(obj: Obj, key: string, fallback: boolean, where: string, errors: string[]): boolean {
  if (!(key in obj)) return fallback;
  const value = obj[key];
  if (typeof value !== "boolean") {
    errors.push(`${where}.${key}: must be a boolean`);
    return fallback;
  }
  return value;
}

function readInteger(obj: Obj, key: string, fallback: number, min: number, max: number, where: string, errors: string[]): number {
  if (!(key in obj)) return fallback;
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${where}.${key}: must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

/** Glob patterns that would silently suppress a rule everywhere. */
function matchesEverything(pattern: string): boolean {
  const normalized = pattern.trim().replace(/^\.?\/+/, "");
  return /^(\*\*?\/?)+(\*(\.\*)?)?$/.test(normalized) || normalized === "";
}

/**
 * Parse and strictly validate `.merge-integrity.yml` text.
 * Unknown keys, unknown rules and invalid values are errors: silent typos are dangerous for enforcement software.
 */
export function parseConfigText(text: string, source: string): ConfigParseResult {
  const errors: string[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    return { ok: false, errors: [`${source}: configuration file is too large (limit ${MAX_CONFIG_BYTES} bytes)`] };
  }

  const doc = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return { ok: false, errors: doc.errors.map((e) => `${source}: YAML error: ${e.message}`) };
  }
  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return { ok: false, errors: [`${source}: YAML error: ${(error as Error).message}`] };
  }
  if (!isObject(root)) {
    return { ok: false, errors: [`${source}: configuration must be a YAML mapping`] };
  }

  checkKeys(root, ["version", "workingDirectory", "framework", "policy", "redGreen", "mutation", "testEnvironment", "rules", "ignore"], source, errors);

  if (root.version !== 1) errors.push(`${source}.version: must be 1`);

  let workingDirectory = DEFAULT_CONFIG.workingDirectory;
  if ("workingDirectory" in root) {
    const wd = root.workingDirectory;
    if (typeof wd !== "string" || !isSafeRelativePath(wd, { allowDot: true })) {
      errors.push(`${source}.workingDirectory: must be a relative path inside the repository`);
    } else {
      workingDirectory = wd;
    }
  }

  let framework: FrameworkSetting = DEFAULT_CONFIG.framework;
  if ("framework" in root) {
    if (root.framework === "auto" || root.framework === "jest" || root.framework === "vitest") {
      framework = root.framework;
    } else {
      errors.push(`${source}.framework: must be one of auto, jest, vitest`);
    }
  }

  const section = (key: string, allowed: string[]): Obj => {
    if (!(key in root)) return {};
    const value = root[key];
    if (!isObject(value)) {
      errors.push(`${source}.${key}: must be a mapping`);
      return {};
    }
    checkKeys(value, allowed, `${source}.${key}`, errors);
    return value;
  };

  const policy = section("policy", ["warningsBlockMerge"]);
  const redGreen = section("redGreen", ["enabled", "timeoutSeconds"]);
  const mutation = section("mutation", ["enabled", "timeoutSeconds", "maxMutants"]);
  const testEnvironment = section("testEnvironment", ["passthrough"]);
  const passthrough: string[] = [];
  if ("passthrough" in testEnvironment) {
    const list = testEnvironment.passthrough;
    if (!Array.isArray(list)) {
      errors.push(`${source}.testEnvironment.passthrough: must be a list of environment variable names`);
    } else {
      for (const name of list) {
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
          errors.push(`${source}.testEnvironment.passthrough: invalid variable name ${JSON.stringify(name)}`);
        } else if (isForbiddenPassthrough(name)) {
          errors.push(`${source}.testEnvironment.passthrough: ${name} can never be passed to repository tests`);
        } else if (!passthrough.includes(name)) {
          passthrough.push(name);
        }
      }
    }
  }

  const rules = { ...DEFAULT_CONFIG.rules };
  if ("rules" in root) {
    if (!isObject(root.rules)) {
      errors.push(`${source}.rules: must be a mapping`);
    } else {
      for (const [id, severity] of Object.entries(root.rules)) {
        if (!isRuleId(id)) {
          errors.push(`${source}.rules: unknown rule ID "${id}"`);
          continue;
        }
        if (severity !== "warn" && severity !== "block") {
          errors.push(`${source}.rules.${id}: severity must be "warn" or "block"`);
          continue;
        }
        rules[id] = severity;
      }
    }
  }

  const ignore: IgnoreEntry[] = [];
  if ("ignore" in root) {
    if (!Array.isArray(root.ignore)) {
      errors.push(`${source}.ignore: must be a list`);
    } else {
      root.ignore.forEach((entry, index) => {
        const where = `${source}.ignore[${index}]`;
        if (!isObject(entry)) {
          errors.push(`${where}: must be a mapping`);
          return;
        }
        checkKeys(entry, ["rule", "path", "reason"], where, errors);
        const { rule, path, reason } = entry;
        let valid = true;
        if (!isRuleId(rule)) {
          errors.push(`${where}.rule: unknown rule ID "${String(rule)}"`);
          valid = false;
        }
        if (typeof path !== "string" || path.trim() === "") {
          errors.push(`${where}.path: a non-empty path glob is required`);
          valid = false;
        } else if (matchesEverything(path)) {
          errors.push(`${where}.path: "${path}" would ignore everything; scope the ignore to specific paths`);
          valid = false;
        } else if (path.includes("..") || path.includes("\0")) {
          errors.push(`${where}.path: must not contain ".." or NUL`);
          valid = false;
        }
        if (typeof reason !== "string" || reason.trim() === "") {
          errors.push(`${where}.reason: a non-empty reason is required`);
          valid = false;
        }
        if (valid) ignore.push({ rule: rule as RuleId, path: path as string, reason: (reason as string).trim() });
      });
    }
  }

  const config: MergeIntegrityConfig = {
    version: 1,
    workingDirectory,
    framework,
    policy: { warningsBlockMerge: readBoolean(policy, "warningsBlockMerge", false, `${source}.policy`, errors) },
    redGreen: {
      enabled: readBoolean(redGreen, "enabled", true, `${source}.redGreen`, errors),
      timeoutSeconds: readInteger(redGreen, "timeoutSeconds", 120, 1, 3600, `${source}.redGreen`, errors),
    },
    mutation: {
      enabled: readBoolean(mutation, "enabled", false, `${source}.mutation`, errors),
      timeoutSeconds: readInteger(mutation, "timeoutSeconds", 180, 1, 7200, `${source}.mutation`, errors),
      maxMutants: readInteger(mutation, "maxMutants", 25, 1, 10000, `${source}.mutation`, errors),
    },
    testEnvironment: { passthrough },
    rules,
    ignore,
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config };
}
