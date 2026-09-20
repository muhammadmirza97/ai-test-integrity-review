import type { Expression, Node, ObjectExpression } from "@babel/types";
import picomatch from "picomatch";
import { isParsableSource, parseSource } from "../ast/parse.js";
import type { Framework } from "../domain/config.js";
import { classifyPath } from "../git/classify.js";
import type { ProjectFileReader } from "./detect.js";

/**
 * Test-file discovery. Default naming conventions are always applied; statically readable custom patterns
 * (Jest `testMatch`, Vitest `test.include` / `test.dir`) are added on top, so custom settings can only widen what is
 * analysed. When discovery depends on settings that cannot be read safely without executing repository code
 * (`testRegex`, projects/workspaces, dynamic or spread configs), the result is `unsupported` and the check reports
 * MI107 instead of implying complete coverage. Repository regular expressions are never compiled.
 */
export type Discovery = {
  kind: "default" | "custom" | "unsupported";
  reason?: string;
  source?: string;
  isTestFile(relPath: string): boolean;
};

const EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts"];
const DISCOVERY_KEYS_JEST = new Set(["testMatch", "testRegex", "projects"]);
const DISCOVERY_KEYS_VITEST = new Set(["include", "dir", "projects", "workspace"]);

const isDefaultTest = (relPath: string) => classifyPath(relPath) === "test";

function propertyKey(node: Node): string | undefined {
  if (node.type !== "ObjectProperty" || node.computed) return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "StringLiteral") return node.key.value;
  return undefined;
}

/** The exported configuration object: `module.exports = {...}`, `export default {...}`, optionally wrapped in defineConfig(). */
function exportedObject(source: string, path: string): ObjectExpression | undefined {
  let ast;
  try {
    ast = parseSource(source, path);
  } catch {
    return undefined;
  }
  let value: Node | undefined;
  for (const statement of ast.program.body) {
    if (statement.type === "ExportDefaultDeclaration") value = statement.declaration;
    if (
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "AssignmentExpression" &&
      statement.expression.left.type === "MemberExpression" &&
      statement.expression.left.object.type === "Identifier" &&
      statement.expression.left.object.name === "module" &&
      statement.expression.left.property.type === "Identifier" &&
      statement.expression.left.property.name === "exports"
    ) {
      value = statement.expression.right;
    }
  }
  while (value && (value.type === "TSAsExpression" || value.type === "TSSatisfiesExpression")) value = value.expression;
  if (
    value?.type === "CallExpression" &&
    value.callee.type === "Identifier" &&
    ["defineConfig", "defineProject"].includes(value.callee.name) &&
    value.arguments.length === 1
  ) {
    value = value.arguments[0] as Expression;
  }
  return value?.type === "ObjectExpression" ? value : undefined;
}

function stringList(node: Node): string[] | undefined {
  if (node.type === "StringLiteral") return [node.value];
  if (node.type !== "ArrayExpression") return undefined;
  const out: string[] = [];
  for (const el of node.elements) {
    if (el?.type !== "StringLiteral") return undefined;
    out.push(el.value);
  }
  return out;
}

function unsupported(reason: string, source: string): Discovery {
  return { kind: "unsupported", reason, source, isTestFile: isDefaultTest };
}

function withPatterns(patterns: string[], source: string): Discovery {
  if (patterns.length === 0) return { kind: "default", isTestFile: isDefaultTest };
  const matchers = patterns.map((p) => picomatch(p.replace(/^<rootDir>\//, "").replace(/^\.\//, ""), { dot: true }));
  return {
    kind: "custom",
    source,
    isTestFile: (relPath) => isDefaultTest(relPath) || (isParsableSource(relPath) && matchers.some((m) => m(relPath))),
  };
}

async function firstExisting(files: ProjectFileReader, names: string[]): Promise<string | undefined> {
  for (const name of names) if (await files.exists(name)) return name;
  return undefined;
}

export async function discoverTestFiles(files: ProjectFileReader, framework: Framework): Promise<Discovery> {
  if (framework === "jest") {
    const configName = await firstExisting(files, [...EXTENSIONS.map((e) => `jest.config.${e}`), "jest.config.json"]);
    let settings: Record<string, unknown> | undefined;
    let source = "package.json";
    if (configName?.endsWith(".json")) {
      source = configName;
      try {
        settings = JSON.parse((await files.readText(configName)) ?? "") as Record<string, unknown>;
      } catch {
        return unsupported("the Jest JSON configuration could not be parsed", configName);
      }
    } else if (configName) {
      const object = exportedObject((await files.readText(configName)) ?? "", configName);
      if (!object) return unsupported("the Jest configuration is not a static object literal", configName);
      const patterns: string[] = [];
      for (const prop of object.properties) {
        const key = propertyKey(prop);
        if (key === undefined) return unsupported("the Jest configuration uses spread or computed properties", configName);
        if (!DISCOVERY_KEYS_JEST.has(key)) continue;
        if (key !== "testMatch") return unsupported(`Jest \`${key}\` cannot be analysed statically`, configName);
        const list = stringList((prop as { value: Node }).value);
        if (!list) return unsupported("Jest `testMatch` is not a static list of strings", configName);
        patterns.push(...list);
      }
      return withPatterns(patterns, configName);
    } else {
      try {
        const pkg = JSON.parse((await files.readText("package.json")) ?? "{}") as Record<string, unknown>;
        settings = typeof pkg.jest === "object" && pkg.jest !== null ? (pkg.jest as Record<string, unknown>) : undefined;
      } catch {
        settings = undefined;
      }
    }
    if (!settings) return { kind: "default", isTestFile: isDefaultTest };
    if (settings.testRegex !== undefined || settings.projects !== undefined) {
      return unsupported("Jest `testRegex`/`projects` cannot be analysed statically", source);
    }
    if (settings.testMatch === undefined) return { kind: "default", isTestFile: isDefaultTest };
    const list = Array.isArray(settings.testMatch) && settings.testMatch.every((p) => typeof p === "string") ? (settings.testMatch as string[]) : undefined;
    return list ? withPatterns(list, source) : unsupported("Jest `testMatch` is not a list of strings", source);
  }

  const workspace = await firstExisting(files, EXTENSIONS.flatMap((e) => [`vitest.workspace.${e}`, `vitest.projects.${e}`]));
  if (workspace) return unsupported("Vitest workspaces/projects cannot be analysed statically", workspace);
  const configName = await firstExisting(files, [...EXTENSIONS.map((e) => `vitest.config.${e}`), ...EXTENSIONS.map((e) => `vite.config.${e}`)]);
  if (!configName) return { kind: "default", isTestFile: isDefaultTest };
  const object = exportedObject((await files.readText(configName)) ?? "", configName);
  if (!object) return unsupported("the Vitest configuration is not a static object literal", configName);
  let testObject: ObjectExpression | undefined;
  for (const prop of object.properties) {
    const key = propertyKey(prop);
    if (key === undefined) return unsupported("the Vitest configuration uses spread or computed properties", configName);
    if (key === "test") {
      const value = (prop as { value: Node }).value;
      if (value.type !== "ObjectExpression") return unsupported("Vitest `test` settings are not a static object", configName);
      testObject = value;
    }
  }
  if (!testObject) return { kind: "default", isTestFile: isDefaultTest };
  let include: string[] | undefined;
  let dir: string | undefined;
  for (const prop of testObject.properties) {
    const key = propertyKey(prop);
    if (key === undefined) return unsupported("Vitest `test` settings use spread or computed properties", configName);
    if (!DISCOVERY_KEYS_VITEST.has(key)) continue;
    const list = stringList((prop as { value: Node }).value);
    if (key === "include" && list) include = list;
    else if (key === "dir" && list?.length === 1) dir = list[0];
    else return unsupported(`Vitest \`test.${key}\` cannot be analysed statically`, configName);
  }
  if (include === undefined && dir === undefined) return { kind: "default", isTestFile: isDefaultTest };
  const base = (dir ?? "").replace(/^\.\//, "").replace(/\/$/, "");
  const patterns = (include ?? ["**/*.{test,spec}.?(c|m)[jt]s?(x)"]).map((p) => (base ? `${base}/${p}` : p));
  return withPatterns(patterns, configName);
}
