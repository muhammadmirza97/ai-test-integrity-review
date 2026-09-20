import type { Framework, FrameworkSetting } from "../domain/config.js";

/** Reads project files relative to the working directory (filesystem or a Git revision). */
export interface ProjectFileReader {
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
}

export type FrameworkDetection =
  | { kind: Framework; evidence: string[] }
  | { kind: "ambiguous"; candidates: Framework[]; evidence: string[]; reason: string }
  | { kind: "unsupported"; evidence: string[]; reason: string };

const CONFIG_EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts", "json"];

const CONFIG_FILES: Record<Framework, string[]> = {
  jest: CONFIG_EXTENSIONS.map((ext) => `jest.config.${ext}`),
  vitest: [
    ...CONFIG_EXTENSIONS.filter((e) => e !== "json").map((ext) => `vitest.config.${ext}`),
    ...CONFIG_EXTENSIONS.filter((e) => e !== "json").map((ext) => `vitest.workspace.${ext}`),
  ],
};

interface PackageJson {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  jest?: unknown;
}

function parsePackageJson(text: string): PackageJson | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function mentions(script: unknown, framework: Framework): boolean {
  return typeof script === "string" && new RegExp(`(^|[\\s/&|;(])${framework}(\\s|$|[&|;)])`).test(script);
}

export async function detectFramework(files: ProjectFileReader, setting: FrameworkSetting = "auto"): Promise<FrameworkDetection> {
  const text = await files.readText("package.json");
  if (text === undefined) {
    return { kind: "unsupported", evidence: [], reason: "package.json not found in the working directory" };
  }
  const pkg = parsePackageJson(text);
  if (!pkg) {
    return { kind: "unsupported", evidence: [], reason: "package.json is not a valid JSON object" };
  }

  const evidence: Record<Framework, string[]> = { jest: [], vitest: [] };
  for (const framework of ["jest", "vitest"] as const) {
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = pkg[field];
      if (deps && typeof deps === "object" && Object.prototype.hasOwnProperty.call(deps, framework)) {
        evidence[framework].push(`package.json ${field}.${framework}`);
      }
    }
    for (const file of CONFIG_FILES[framework]) {
      if (await files.exists(file)) evidence[framework].push(`config file ${file}`);
    }
  }
  if (pkg.jest !== undefined) evidence.jest.push('package.json "jest" field');

  const allEvidence = [...evidence.jest, ...evidence.vitest];

  if (setting !== "auto") {
    if (evidence[setting].length === 0) {
      return {
        kind: "unsupported",
        evidence: allEvidence,
        reason: `framework "${setting}" was configured but no ${setting} dependency or config file was found`,
      };
    }
    return { kind: setting, evidence: evidence[setting] };
  }

  const candidates = (["jest", "vitest"] as const).filter((f) => evidence[f].length > 0);
  if (candidates.length === 1) {
    const only = candidates[0] as Framework;
    return { kind: only, evidence: evidence[only] };
  }
  if (candidates.length === 0) {
    return { kind: "unsupported", evidence: [], reason: "no Jest or Vitest dependency or configuration was found" };
  }

  const testScript = pkg.scripts?.test;
  const mentioned = candidates.filter((f) => mentions(testScript, f));
  if (mentioned.length === 1) {
    const chosen = mentioned[0] as Framework;
    return { kind: chosen, evidence: [...evidence[chosen], "package.json scripts.test"] };
  }
  return {
    kind: "ambiguous",
    candidates: [...candidates],
    evidence: allEvidence,
    reason: "both Jest and Vitest were detected; set `framework` explicitly",
  };
}
