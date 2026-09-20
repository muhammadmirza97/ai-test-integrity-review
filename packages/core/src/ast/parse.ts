import { parse, type ParserPlugin } from "@babel/parser";
import type { File, Node } from "@babel/types";

export const MAX_PARSE_BYTES = 2 * 1024 * 1024;

export class SourceParseError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "SourceParseError";
  }
}

const JS_EXTENSIONS = /\.(c|m)?jsx?$/i;
const TS_EXTENSIONS = /\.(c|m)?ts$/i;
const TSX_EXTENSION = /\.tsx$/i;

export function isParsableSource(path: string): boolean {
  return (JS_EXTENSIONS.test(path) || TS_EXTENSIONS.test(path) || TSX_EXTENSION.test(path)) && !/\.d\.(c|m)?ts$/i.test(path);
}

function pluginsFor(path: string): ParserPlugin[] {
  if (TSX_EXTENSION.test(path)) return ["typescript", "jsx", "decorators-legacy"];
  if (TS_EXTENSIONS.test(path)) return ["typescript", "decorators-legacy"];
  return ["jsx", "decorators-legacy"];
}

/**
 * Parse JavaScript/TypeScript source deterministically. Throws SourceParseError on oversize or syntax errors;
 * callers must turn that into ERROR rather than skipping the file (a skipped file is a false-PASS path).
 */
export function parseSource(text: string, path: string): File {
  if (Buffer.byteLength(text, "utf8") > MAX_PARSE_BYTES) {
    throw new SourceParseError(path, `file exceeds the ${MAX_PARSE_BYTES}-byte analysis limit`);
  }
  try {
    return parse(text, {
      sourceType: "unambiguous",
      sourceFilename: path,
      plugins: pluginsFor(path),
      errorRecovery: false,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowUndeclaredExports: true,
    });
  } catch (error) {
    if (error instanceof RangeError) throw new SourceParseError(path, "file is too deeply nested to analyse");
    throw new SourceParseError(path, `syntax error: ${(error as Error).message}`);
  }
}

const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "range", "tokens"]);

export function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Direct AST children of a node, in source order. */
export function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/**
 * JSON for scalar AST values. A bigint (e.g. a BigIntLiteral's value) is written as its decimal digits followed by
 * `n`, unquoted: JSON.stringify cannot serialise bigint, and this form can never equal a JSON number or string.
 */
function scalar(value: unknown): string {
  return typeof value === "bigint" ? `${value.toString()}n` : String(JSON.stringify(value));
}

/**
 * Canonical, position-independent serialisation of a node, used to compare expressions across revisions.
 * Comments, whitespace, parentheses and quote style do not affect the result.
 */
export function canonical(node: Node | null | undefined): string {
  if (!node) return "";
  const parts: string[] = [node.type];
  for (const key of Object.keys(node).sort()) {
    if (SKIP_KEYS.has(key) || key === "type") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      parts.push(`${key}:[${value.map((v) => (isNode(v) ? canonical(v) : scalar(v ?? null))).join(",")}]`);
    } else if (isNode(value)) {
      parts.push(`${key}:${canonical(value)}`);
    } else if (value !== undefined && typeof value !== "object") {
      parts.push(`${key}:${scalar(value)}`);
    } else if (value === null) {
      parts.push(`${key}:null`);
    } else if (typeof value === "object" && value !== null && key === "value") {
      // TemplateElement { raw, cooked }
      parts.push(`${key}:${JSON.stringify((value as { cooked?: unknown }).cooked ?? null)}`);
    }
  }
  return `(${parts.join(" ")})`;
}
