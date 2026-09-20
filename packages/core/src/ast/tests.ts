import { createHash } from "node:crypto";
import type { CallExpression, File, Node, Program } from "@babel/types";
import { canonical, childrenOf, parseSource, SourceParseError } from "./parse.js";

export type SkipKind = "none" | "unconditional" | "conditional";
export type BlockKind = "suite" | "test" | "hook";
export type AssertionStyle = "expect" | "chai" | "assert" | "meta";

export interface LiteralValue {
  value: unknown;
}

export interface AssertionModel {
  /** Canonical signature of the whole assertion expression. */
  signature: string;
  style: AssertionStyle;
  /** Canonical form of the value under test (`expect(...)` arguments). */
  subject: string;
  subjectLiterals: (LiteralValue | null)[];
  /** Chain modifiers other than `not` (e.g. resolves, rejects, to, be). */
  modifiers: string[];
  negated: boolean;
  matcher: string;
  args: string[];
  argLiterals: (LiteralValue | null)[];
  line: number;
  text: string;
}

export interface TestBlock {
  kind: BlockKind;
  name: string;
  dynamicName: boolean;
  path: string[];
  key: string;
  line: number;
  endLine: number;
  /** Source text of the API call that declared the block, e.g. `it.skip`. */
  api: string;
  skip: SkipKind;
  todo: boolean;
  focused: boolean;
  inverted: boolean;
  table: boolean;
  hasCallback: boolean;
  assertions: AssertionModel[];
  /** Sorted, de-duplicated names of non-assertion calls inside the block body. */
  calls: string[];
  bodySignature: string;
  /**
   * Fingerprint of the code around the block that can change which cases it generates: the enclosing statement in
   * the nearest suite (or file) body, that body's declarations, and any enclosing table/dynamic suite. Set only when
   * the block's identity is not unique (runtime-generated or table name, dynamic enclosing suite, or a name
   * duplicated in the file); empty otherwise.
   */
  contextSignature: string;
}

export interface TestFileModel {
  blocks: TestBlock[];
}

const SUITE_BASES = new Set(["describe", "suite", "context"]);
const TEST_BASES = new Set(["it", "test", "specify"]);
const HOOK_BASES = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const ALIAS_BASES: Record<string, { base: string; modifier: string }> = {
  xit: { base: "it", modifier: "skip" },
  xtest: { base: "test", modifier: "skip" },
  xdescribe: { base: "describe", modifier: "skip" },
  fit: { base: "it", modifier: "only" },
  fdescribe: { base: "describe", modifier: "only" },
};
const MODIFIERS = new Set([
  "skip",
  "only",
  "todo",
  "each",
  "for",
  "concurrent",
  "sequential",
  "shuffle",
  "fails",
  "failing",
  "skipIf",
  "runIf",
]);
const FACTORY_MODIFIERS = new Set(["each", "for", "skipIf", "runIf"]);
const TEST_MODULES = new Set(["vitest", "@jest/globals"]);
interface Bindings {
  /** local name -> canonical API name */
  aliases: Map<string, string>;
  namespaces: Set<string>;
}

function propertyName(node: Node): string | undefined {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "StringLiteral") return node.property.value;
  return undefined;
}

function collectBindings(program: Program): Bindings {
  const bindings: Bindings = { aliases: new Map(), namespaces: new Set() };
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const fromTestModule = TEST_MODULES.has(statement.source.value);
    const fromAssert = ["assert", "node:assert", "node:assert/strict", "assert/strict", "chai"].includes(statement.source.value);
    for (const spec of statement.specifiers) {
      if (spec.type === "ImportNamespaceSpecifier") {
        if (fromTestModule) bindings.namespaces.add(spec.local.name);
        else if (fromAssert) bindings.aliases.set(spec.local.name, "assert");
        continue;
      }
      if (spec.type === "ImportDefaultSpecifier") {
        if (fromAssert) bindings.aliases.set(spec.local.name, "assert");
        continue;
      }
      const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      if (fromTestModule || (fromAssert && (imported === "assert" || imported === "expect"))) {
        bindings.aliases.set(spec.local.name, imported);
      }
    }
  }
  // `const myTest = test.extend({...})` creates a test function with the same modifiers.
  for (const statement of program.body) {
    const declaration =
      statement.type === "VariableDeclaration"
        ? statement
        : statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "VariableDeclaration"
          ? statement.declaration
          : undefined;
    if (!declaration) continue;
    for (const declarator of declaration.declarations) {
      const init = declarator.init;
      if (declarator.id.type !== "Identifier" || init?.type !== "CallExpression") continue;
      if (propertyName(init.callee) !== "extend") continue;
      const object = (init.callee as { object: Node }).object;
      if (object.type === "Identifier") {
        const base = resolveName(object.name, bindings);
        if (base && TEST_BASES.has(base)) bindings.aliases.set(declarator.id.name, base);
      }
    }
  }
  return bindings;
}

function resolveName(name: string, bindings: Bindings): string | undefined {
  // Identifiers named like a test API are treated as that API even when imported from another module:
  // a locally re-exported `it` must not hide `.skip`/`.only` (false negatives are worse than rare noise here).
  return bindings.aliases.get(name) ?? name;
}

interface DecodedTestCall {
  base: string;
  modifiers: string[];
  conditions: { kind: "skipIf" | "runIf"; arg: Node | undefined }[];
}

function decodeTestCallee(callee: Node, bindings: Bindings): DecodedTestCall | undefined {
  // `test.each(table)` on its own is a factory call, not a test declaration.
  const outerProperty = propertyName(callee);
  if (outerProperty !== undefined && FACTORY_MODIFIERS.has(outerProperty)) return undefined;

  const modifiers: string[] = [];
  const conditions: DecodedTestCall["conditions"] = [];
  let current: Node = callee;
  let base: string | undefined;
  for (let depth = 0; depth < 16; depth++) {
    if (current.type === "Identifier") {
      base = resolveName(current.name, bindings);
      break;
    }
    if (current.type === "MemberExpression") {
      const prop = propertyName(current);
      if (prop === undefined) return undefined;
      if (current.object.type === "Identifier" && bindings.namespaces.has(current.object.name)) {
        base = prop;
        break;
      }
      modifiers.unshift(prop);
      current = current.object;
      continue;
    }
    if (current.type === "CallExpression") {
      const prop = propertyName(current.callee);
      if (prop === undefined || !FACTORY_MODIFIERS.has(prop)) return undefined;
      modifiers.unshift(prop);
      if (prop === "skipIf" || prop === "runIf") conditions.push({ kind: prop, arg: current.arguments[0] });
      current = (current.callee as { object: Node }).object;
      continue;
    }
    if (current.type === "TaggedTemplateExpression") {
      const prop = propertyName(current.tag);
      if (prop !== "each" && prop !== "for") return undefined;
      modifiers.unshift(prop);
      current = (current.tag as { object: Node }).object;
      continue;
    }
    return undefined;
  }
  if (base === undefined) return undefined;
  const alias = ALIAS_BASES[base];
  if (alias) {
    base = alias.base;
    modifiers.unshift(alias.modifier);
  }
  if (!SUITE_BASES.has(base) && !TEST_BASES.has(base) && !HOOK_BASES.has(base)) return undefined;
  if (!modifiers.every((m) => MODIFIERS.has(m))) return undefined;
  return { base, modifiers, conditions };
}

export function literalOf(node: Node | undefined | null): LiteralValue | null {
  if (!node) return null;
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return { value: node.value };
    case "NullLiteral":
      return { value: null };
    case "Identifier":
      return node.name === "undefined" ? { value: undefined } : node.name === "NaN" ? { value: Number.NaN } : null;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral") return { value: -node.argument.value };
      if (node.operator === "!" && node.argument.type === "NumericLiteral") return { value: !node.argument.value };
      return null;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? { value: node.quasis.map((q) => q.value.cooked ?? "").join("") } : null;
    default:
      return null;
  }
}

function blockName(arg: Node | undefined): { name: string; dynamic: boolean } {
  if (arg?.type === "StringLiteral") return { name: arg.value, dynamic: false };
  if (arg?.type === "TemplateLiteral" && arg.expressions.length === 0) {
    return { name: arg.quasis.map((q) => q.value.cooked ?? "").join(""), dynamic: false };
  }
  return { name: `<dynamic ${canonical(arg).slice(0, 120)}>`, dynamic: true };
}

function isFunctionNode(node: Node | undefined): node is Extract<Node, { body: unknown }> & Node {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

const CHAI_WORDS = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "same", "but", "does", "deep", "nested", "own", "ordered", "any", "all", "a", "an"]);

function isExpectCallee(callee: Node, bindings: Bindings): boolean {
  if (callee.type === "Identifier") {
    const name = resolveName(callee.name, bindings);
    return name === "expect" || name === "expectTypeOf";
  }
  const prop = propertyName(callee);
  if ((prop === "soft" || prop === "poll") && callee.type === "MemberExpression" && callee.object.type === "Identifier") {
    return resolveName(callee.object.name, bindings) === "expect";
  }
  return false;
}

const DECLARATIONS = new Set(["VariableDeclaration", "FunctionDeclaration", "ClassDeclaration"]);

interface BodyScope {
  declarations: Node[];
  declarationSignature?: string;
}

interface BlockContext {
  body: BodyScope;
  statement: Node;
  dynamicSuites: string[];
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

class Extractor {
  readonly blocks: TestBlock[] = [];
  private readonly hookCounters = new Map<string, number>();
  private readonly scopes: { body: BodyScope; statement: Node }[] = [];
  private readonly dynamicSuites: string[] = [];
  private readonly contexts = new Map<TestBlock, BlockContext>();
  private readonly statementSignatures = new Map<Node, string>();

  constructor(
    private readonly source: string,
    private readonly bindings: Bindings,
  ) {}

  private text(node: Node): string {
    const raw = this.source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, " ").trim();
    return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
  }

  /** Walk a file or suite body statement by statement, remembering the enclosing statement for context fingerprints. */
  walkBody(body: Node, path: string[]): void {
    const statements = body.type === "BlockStatement" || body.type === "Program" ? (body.body as Node[]) : [body];
    const scope: BodyScope = { declarations: statements.filter((s) => DECLARATIONS.has(s.type)) };
    for (const statement of statements) {
      this.scopes.push({ body: scope, statement });
      this.walk(statement, path, undefined);
      this.scopes.pop();
    }
  }

  /** Fill contextSignature for blocks whose identity is not unique within the file. */
  finish(): void {
    const keyCounts = new Map<string, number>();
    for (const block of this.blocks) keyCounts.set(block.key, (keyCounts.get(block.key) ?? 0) + 1);
    for (const block of this.blocks) {
      const context = this.contexts.get(block);
      if (!context) continue;
      const unique = !block.dynamicName && !block.table && context.dynamicSuites.length === 0 && keyCounts.get(block.key) === 1;
      if (unique) continue;
      context.body.declarationSignature ??= digest(context.body.declarations.map((d) => canonical(d)).join("\n"));
      let statement = this.statementSignatures.get(context.statement);
      if (statement === undefined) {
        statement = digest(canonical(context.statement));
        this.statementSignatures.set(context.statement, statement);
      }
      block.contextSignature = digest([...context.dynamicSuites, context.body.declarationSignature, statement].join("\0"));
    }
  }

  walk(node: Node, path: string[], owner: TestBlock | undefined): void {
    if (node.type === "CallExpression" && this.tryTestCall(node, path)) return;

    if (owner) {
      if (node.type === "CallExpression") {
        const assertion = this.decodeAssertion(node);
        if (assertion) {
          owner.assertions.push(assertion.model);
          for (const child of assertion.nested) this.walk(child, path, owner);
          return;
        }
        const name = this.calleeName(node.callee);
        if (name !== undefined) owner.calls.push(name);
      } else if (node.type === "ExpressionStatement" && node.expression.type === "MemberExpression") {
        const assertion = this.decodePropertyAssertion(node.expression);
        if (assertion) {
          owner.assertions.push(assertion);
          return;
        }
      }
    }
    for (const child of childrenOf(node)) this.walk(child, path, owner);
  }

  private tryTestCall(node: CallExpression, path: string[]): boolean {
    const decoded = decodeTestCallee(node.callee, this.bindings);
    if (!decoded) return false;

    const kind: BlockKind = SUITE_BASES.has(decoded.base) ? "suite" : TEST_BASES.has(decoded.base) ? "test" : "hook";
    const args = node.arguments as Node[];
    let name: { name: string; dynamic: boolean };
    if (kind === "hook") {
      const counterKey = JSON.stringify([...path, decoded.base]);
      const index = this.hookCounters.get(counterKey) ?? 0;
      this.hookCounters.set(counterKey, index + 1);
      name = { name: `${decoded.base}#${index}`, dynamic: false };
    } else {
      name = blockName(args[0]);
    }
    const callback = args.find((arg, i) => (kind === "hook" || i > 0) && isFunctionNode(arg)) as
      | (Node & { body: Node })
      | undefined;

    let skip: SkipKind = decoded.modifiers.includes("skip") ? "unconditional" : "none";
    for (const condition of decoded.conditions) {
      const literal = literalOf(condition.arg);
      if (literal === null) {
        if (skip === "none") skip = "conditional";
      } else if ((condition.kind === "skipIf") === Boolean(literal.value)) {
        skip = "unconditional";
      }
    }

    const block: TestBlock = {
      kind,
      name: name.name,
      dynamicName: name.dynamic,
      path: [...path],
      key: JSON.stringify([kind, ...path, name.name]),
      line: node.loc?.start.line ?? 0,
      endLine: node.loc?.end.line ?? 0,
      api: this.text(node.callee),
      skip,
      todo: decoded.modifiers.includes("todo"),
      focused: decoded.modifiers.includes("only"),
      inverted: decoded.modifiers.includes("fails") || decoded.modifiers.includes("failing"),
      table: decoded.modifiers.includes("each") || decoded.modifiers.includes("for"),
      hasCallback: callback !== undefined,
      assertions: [],
      calls: [],
      bodySignature: callback ? canonical(callback.body) : "",
      contextSignature: "",
    };
    this.blocks.push(block);
    const scope = this.scopes[this.scopes.length - 1];
    if (scope) this.contexts.set(block, { body: scope.body, statement: scope.statement, dynamicSuites: [...this.dynamicSuites] });

    // Table arguments and conditions may contain nested calls but never test declarations of interest.
    if (callback) {
      if (kind === "suite") {
        const dynamicSuite = name.dynamic || block.table;
        if (dynamicSuite) this.dynamicSuites.push(digest(`${canonical(node.callee)}\0${name.name}`));
        this.walkBody(callback.body, [...path, name.name]);
        if (dynamicSuite) this.dynamicSuites.pop();
      } else {
        this.walk(callback.body, path, block);
      }
    }
    block.calls = [...new Set(block.calls)].sort();
    return true;
  }

  private calleeName(callee: Node): string | undefined {
    if (callee.type === "Identifier") return callee.name;
    if (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") {
      const prop = propertyName(callee);
      const object = this.calleeName(callee.object);
      return prop !== undefined && object !== undefined ? `${object}.${prop}` : undefined;
    }
    if (callee.type === "ThisExpression") return "this";
    return undefined;
  }

  private decodeAssertion(node: CallExpression): { model: AssertionModel; nested: Node[] } | undefined {
    const callee = node.callee;
    const args = node.arguments as Node[];
    const line = node.loc?.start.line ?? 0;

    // Node/chai assert style: assert(x), assert.equal(a, b)
    if (callee.type === "Identifier" && resolveName(callee.name, this.bindings) === "assert") {
      return { model: this.model(node, "assert", args.slice(0, 1), [], false, "assert", args.slice(1), line), nested: args };
    }
    if (callee.type === "MemberExpression" && callee.object.type === "Identifier") {
      const prop = propertyName(callee);
      const root = resolveName(callee.object.name, this.bindings);
      if (root === "assert" && prop !== undefined) {
        return { model: this.model(node, "assert", args.slice(0, 1), [], false, prop, args.slice(1), line), nested: args };
      }
      if (root === "expect" && (prop === "assertions" || prop === "hasAssertions")) {
        return { model: this.model(node, "meta", [], [], false, prop, args, line), nested: [] };
      }
    }

    if (callee.type !== "MemberExpression") return undefined;
    const matcher = propertyName(callee);
    if (matcher === undefined) return undefined;
    const chain: string[] = [];
    let current: Node = callee.object;
    while (current.type === "MemberExpression") {
      const prop = propertyName(current);
      if (prop === undefined) return undefined;
      chain.unshift(prop);
      current = current.object;
    }
    if (current.type !== "CallExpression" || !isExpectCallee(current.callee, this.bindings)) return undefined;
    const subjectArgs = current.arguments as Node[];
    const negated = chain.includes("not");
    const modifiers = chain.filter((m) => m !== "not");
    const style: AssertionStyle = modifiers.some((m) => CHAI_WORDS.has(m)) ? "chai" : "expect";
    return {
      model: this.model(node, style, subjectArgs, modifiers, negated, matcher, args, line),
      nested: [...subjectArgs, ...args],
    };
  }

  private decodePropertyAssertion(member: Node): AssertionModel | undefined {
    if (member.type !== "MemberExpression") return undefined;
    const matcher = propertyName(member);
    if (matcher === undefined) return undefined;
    const chain: string[] = [];
    let current: Node = member.object;
    while (current.type === "MemberExpression") {
      const prop = propertyName(current);
      if (prop === undefined) return undefined;
      chain.unshift(prop);
      current = current.object;
    }
    if (current.type !== "CallExpression" || !isExpectCallee(current.callee, this.bindings) || chain.length === 0) return undefined;
    const negated = chain.includes("not");
    return this.model(
      member,
      "chai",
      current.arguments as Node[],
      chain.filter((m) => m !== "not"),
      negated,
      matcher,
      [],
      member.loc?.start.line ?? 0,
    );
  }

  private model(
    node: Node,
    style: AssertionStyle,
    subjectArgs: Node[],
    modifiers: string[],
    negated: boolean,
    matcher: string,
    args: Node[],
    line: number,
  ): AssertionModel {
    return {
      signature: canonical(node),
      style,
      subject: subjectArgs.map((a) => canonical(a)).join(","),
      subjectLiterals: subjectArgs.map((a) => literalOf(a)),
      modifiers,
      negated,
      matcher,
      args: args.map((a) => canonical(a)),
      argLiterals: args.map((a) => literalOf(a)),
      line,
      text: this.text(node),
    };
  }
}

export function extractTestModel(ast: File, source: string): TestFileModel {
  const bindings = collectBindings(ast.program);
  const extractor = new Extractor(source, bindings);
  extractor.walkBody(ast.program, []);
  extractor.finish();
  return { blocks: extractor.blocks };
}

/** Parse and model a test file. Throws SourceParseError when the file cannot be analysed. */
export function analyzeTestSource(source: string, path: string): TestFileModel {
  const ast = parseSource(source, path);
  try {
    return extractTestModel(ast, source);
  } catch (error) {
    if (error instanceof RangeError) throw new SourceParseError(path, "file is too deeply nested to analyse");
    throw error;
  }
}

