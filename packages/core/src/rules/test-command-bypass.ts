import type { Node } from "@babel/types";
import { canonical, childrenOf, parseSource } from "../ast/parse.js";
import type { RawFinding } from "../domain/finding.js";

/**
 * MI005 (BLOCK) and MI105 (WARN): deterministic detection of test-command and test-configuration bypasses.
 * Scripts are tokenised as data; nothing here executes or evaluates repository content.
 */

const SWALLOW_TARGETS = new Set(["true", ":", "echo", "printf"]);
const NAME_FILTER_FLAGS = new Set(["-t", "--testNamePattern", "--test-name-pattern"]);
const SCOPE_FLAGS = new Set([
  "--testPathIgnorePatterns",
  "--exclude",
  "--onlyChanged",
  "-o",
  "--changed",
  "--changedSince",
  "--related",
  "--findRelatedTests",
  "--lastCommit",
  "--no-coverage",
  "--coverage=false",
  "--testPathPattern",
  "--testPathPatterns",
]);
const RUNNER = /(^|[/\\])(jest|vitest)(\.c?m?js|\.cmd)?$/;
const NOOP_COMMANDS = new Set(["echo", "exit", "true", ":", "printf"]);
const OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

export function tokenizeScript(script: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const push = () => {
    if (current !== "") tokens.push(current);
    current = "";
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      tokens.push(two);
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      push();
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function segments(tokens: string[]): { op: string | null; words: string[] }[] {
  const result: { op: string | null; words: string[] }[] = [];
  let op: string | null = null;
  let words: string[] = [];
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      result.push({ op, words });
      op = token;
      words = [];
    } else {
      words.push(token);
    }
  }
  result.push({ op, words });
  return result.filter((s) => s.words.length > 0 || s.op !== null);
}

export interface ScriptFacts {
  invokesRunner: "yes" | "no" | "unknown";
  passWithNoTests: number;
  swallowsFailure: number;
  nameFilters: number;
  scopeFlags: string[];
}

function flagName(word: string): string {
  if (word === "--coverage=false") return word;
  const eq = word.indexOf("=");
  return eq > 0 ? word.slice(0, eq) : word;
}

function referencedScript(words: string[]): string | undefined {
  const [cmd, a, b] = words;
  if (cmd === undefined) return undefined;
  const manager = cmd.replace(/\.cmd$/, "");
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return undefined;
  if (a === "test" || a === "t") return "test";
  if ((a === "run" || a === "run-script") && b !== undefined) return b;
  if ((manager === "pnpm" || manager === "yarn") && a !== undefined && !a.startsWith("-") && !["exec", "dlx", "install", "add"].includes(a)) {
    return a;
  }
  return undefined;
}

export function analyzeScript(name: string, scripts: Record<string, string>, seen: Set<string> = new Set()): ScriptFacts {
  const facts: ScriptFacts = { invokesRunner: "no", passWithNoTests: 0, swallowsFailure: 0, nameFilters: 0, scopeFlags: [] };
  const script = scripts[name];
  if (script === undefined || seen.has(name) || seen.size > 8) {
    facts.invokesRunner = "unknown";
    return facts;
  }
  seen.add(name);
  const tokens = tokenizeScript(script);
  const verdicts: ScriptFacts["invokesRunner"][] = [];
  for (const segment of segments(tokens)) {
    const words = segment.words.filter((w, i) => !(i === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)));
    for (const word of words) {
      const flag = flagName(word);
      if (flag === "--passWithNoTests" && !/=false$/.test(word)) facts.passWithNoTests++;
      if (NAME_FILTER_FLAGS.has(flag)) facts.nameFilters++;
      if (SCOPE_FLAGS.has(flag)) facts.scopeFlags.push(flag);
    }
    // After a test-runner segment, `|| true`, `; echo done`, `| tee log` and `&` make the script's exit status
    // independent of the test run.
    const first = words[0];
    const alwaysSucceeds = first !== undefined && (SWALLOW_TARGETS.has(first) || (first === "exit" && words[1] === "0"));
    const statusPreservingExit = first === "exit" && words[1] !== "0";
    const runnerSeen = verdicts.includes("yes");

    let verdict: ScriptFacts["invokesRunner"] | undefined;
    if (words.length > 0) {
      if (words.some((w) => RUNNER.test(w))) {
        verdict = "yes";
      } else {
        const ref = referencedScript(words);
        if (ref !== undefined) {
          const nested = analyzeScript(ref, scripts, seen);
          facts.passWithNoTests += nested.passWithNoTests;
          facts.swallowsFailure += nested.swallowsFailure;
          facts.nameFilters += nested.nameFilters;
          facts.scopeFlags.push(...nested.scopeFlags);
          verdict = nested.invokesRunner;
        } else {
          verdict = NOOP_COMMANDS.has(first as string) ? "no" : "unknown";
        }
      }
    }
    if (
      runnerSeen &&
      ((segment.op === "||" && alwaysSucceeds) ||
        (segment.op === ";" && words.length > 0 && verdict !== "yes" && !statusPreservingExit) ||
        segment.op === "|" ||
        segment.op === "&")
    ) {
      facts.swallowsFailure++;
    }
    if (verdict !== undefined) verdicts.push(verdict);
  }
  facts.invokesRunner = verdicts.includes("yes") ? "yes" : verdicts.every((v) => v === "no") ? "no" : "unknown";
  facts.scopeFlags.sort();
  return facts;
}

function parseManifest(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringScripts(manifest: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = manifest?.scripts;
  if (typeof scripts !== "object" || scripts === null) return {};
  return Object.fromEntries(Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === "string"));
}

const SCOPE_KEYS = new Set([
  "testMatch",
  "testRegex",
  "testPathIgnorePatterns",
  "roots",
  "modulePathIgnorePatterns",
  "collectCoverageFrom",
  "coveragePathIgnorePatterns",
  "coverageThreshold",
  "thresholds",
  "include",
  "exclude",
  "dir",
  "projects",
  "allowOnly",
  "testNamePattern",
]);

interface ConfigFacts {
  passWithNoTests: number;
  scope: string[];
}

function valueFacts(value: unknown): ConfigFacts {
  const facts: ConfigFacts = { passWithNoTests: 0, scope: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return facts;
  for (const [key, v] of Object.entries(value)) {
    if (key === "passWithNoTests" && v === true) facts.passWithNoTests++;
    if (SCOPE_KEYS.has(key)) facts.scope.push(`${key}=${JSON.stringify(v)}`);
  }
  facts.scope.sort();
  return facts;
}

/** Facts from a JS/TS test configuration. For Vite/Vitest configs only properties under `test` count. */
export function configFileFacts(text: string, path: string): ConfigFacts {
  if (path.endsWith(".json")) {
    try {
      return valueFacts(JSON.parse(text));
    } catch {
      return { passWithNoTests: 0, scope: ["<unparsable json>"] };
    }
  }
  const ast = parseSource(text, path);
  const requireTestAncestor = /^(vite|vitest)\./.test(path.split("/").at(-1) ?? "");
  const facts: ConfigFacts = { passWithNoTests: 0, scope: [] };
  const visit = (node: Node, keys: string[]) => {
    if (node.type === "ObjectProperty") {
      const key =
        node.key.type === "Identifier" ? node.key.name : node.key.type === "StringLiteral" ? node.key.value : undefined;
      if (key !== undefined) {
        const inScope = !requireTestAncestor || keys.includes("test") || /^vitest\.(workspace|projects)\./.test(path);
        if (inScope && key === "passWithNoTests" && node.value.type === "BooleanLiteral" && node.value.value) facts.passWithNoTests++;
        if (inScope && SCOPE_KEYS.has(key)) facts.scope.push(`${[...keys, key].join(".")}=${canonical(node.value)}`);
        visit(node.value, [...keys, key]);
        return;
      }
    }
    for (const child of childrenOf(node)) visit(child, keys);
  };
  visit(ast.program, []);
  facts.scope.sort();
  return facts;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function comparePackageManifest(file: string, baseText: string | undefined, headText: string | undefined): RawFinding[] {
  const findings: RawFinding[] = [];
  const base = parseManifest(baseText);
  const head = parseManifest(headText);
  if (!base || !head) return findings;
  const baseScripts = stringScripts(base);
  const headScripts = stringScripts(head);

  if (baseScripts.test !== undefined && headScripts.test === undefined) {
    findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: 'The "test" script was removed from package.json.' });
  }

  for (const name of Object.keys(baseScripts).filter((n) => /^test(:|$)/.test(n)).sort()) {
    if (headScripts[name] === undefined) continue;
    const before = analyzeScript(name, baseScripts);
    const after = analyzeScript(name, headScripts);
    const quoted = `script "${name}" (\`${headScripts[name]}\`)`;
    if (before.invokesRunner === "yes" && after.invokesRunner === "no") {
      findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: `The ${quoted} no longer runs Jest or Vitest.` });
    } else if (before.invokesRunner === "yes" && after.invokesRunner === "unknown") {
      findings.push({
        ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
        file,
        message: `The ${quoted} no longer visibly runs Jest or Vitest; confirm the tests still execute.`,
      });
    }
    if (after.passWithNoTests > before.passWithNoTests) {
      findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: `The ${quoted} now passes when no tests run (--passWithNoTests).` });
    }
    if (after.swallowsFailure > before.swallowsFailure) {
      findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: `The ${quoted} now ignores test failures.` });
    }
    if (after.nameFilters > before.nameFilters) {
      findings.push({
        ruleId: name === "test" ? "MI005_TEST_COMMAND_BYPASS" : "MI105_COVERAGE_SCOPE_REDUCED",
        file,
        message: `The ${quoted} now filters tests by name and runs only a subset.`,
      });
    }
    const newFlags = after.scopeFlags.filter((f) => !before.scopeFlags.includes(f));
    if (newFlags.length > 0) {
      findings.push({
        ruleId: "MI105_COVERAGE_SCOPE_REDUCED",
        file,
        message: `The ${quoted} adds scope-narrowing options: ${[...new Set(newFlags)].join(", ")}.`,
      });
    }
  }

  const baseJest = valueFacts(base.jest);
  const headJest = valueFacts(head.jest);
  if (headJest.passWithNoTests > baseJest.passWithNoTests) {
    findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: 'package.json "jest.passWithNoTests" was enabled.' });
  }
  if (!sameList(baseJest.scope, headJest.scope)) {
    findings.push({
      ruleId: "MI105_COVERAGE_SCOPE_REDUCED",
      file,
      message: 'package.json "jest" test selection or coverage settings changed; confirm verification scope was not reduced.',
    });
  }
  return findings;
}

export function compareTestConfig(file: string, baseText: string | undefined, headText: string | undefined): RawFinding[] {
  const findings: RawFinding[] = [];
  const base = baseText === undefined ? { passWithNoTests: 0, scope: [] } : configFileFacts(baseText, file);
  if (headText === undefined) {
    if (baseText !== undefined) {
      findings.push({
        ruleId: "MI105_COVERAGE_SCOPE_REDUCED",
        file,
        message: "A test runner configuration file was deleted; confirm verification scope was not reduced.",
      });
    }
    return findings;
  }
  const head = configFileFacts(headText, file);
  if (head.passWithNoTests > base.passWithNoTests) {
    findings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: "passWithNoTests was enabled in the test configuration." });
  }
  // Also for newly added configs: selection keys in a new config change what runs and what is analysed.
  if (!sameList(base.scope, head.scope)) {
    findings.push({
      ruleId: "MI105_COVERAGE_SCOPE_REDUCED",
      file,
      message: "Test selection, exclusion or coverage-threshold settings changed; confirm verification scope was not reduced.",
    });
  }
  return findings;
}

