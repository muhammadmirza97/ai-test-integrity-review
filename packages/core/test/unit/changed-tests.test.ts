import { describe, expect, it } from "vitest";
import { canonical, parseSource } from "../../src/ast/parse.js";
import { analyzeTestSource } from "../../src/ast/tests.js";
import { compareTestFile } from "../../src/rules/test-integrity.js";

const FILE = "test/example.test.ts";
const changed = (base: string, head: string) =>
  compareTestFile(FILE, analyzeTestSource(base, FILE), analyzeTestSource(head, FILE)).changedTests.map((t) => t.namePath.join(" > "));

// Calibration D1 (harrisiirak/cron-parser#445, #450): unchanged tests with duplicate names and an unchanged test whose
// name is generated at runtime were reported as changed because another test in the same file changed.
const CRON_BASE = `describe("parser", () => {
  test("range test with repeat (second)", () => { expect(parse("1-5/2")).toEqual([1, 3, 5]); });
  test("range test with repeat (second)", () => { expect(parse("0-4/2")).toEqual([0, 2, 4]); });
  describe("last of flag", () => {
    for (const expression of ["0 0 L * *", "0 0 L-1 * *"]) {
      test(\`parses cron with last weekday: \${expression}\`, () => { expect(() => parse(expression)).not.toThrow(); });
    }
  });
  describe("invalid expression", () => {
    test("rejects garbage", () => { expect(() => parse("x")).toThrow(); });
  });
});
`;

describe("changed-test identity (D1)", () => {
  it("does not treat unchanged duplicate-named or runtime-named tests as changed when another test changes", () => {
    const head = CRON_BASE.replace(
      `    test("rejects garbage"`,
      `    test("rejects duplicated zero values", () => { expect(() => parse("0,0 * * * *")).toThrow(); });\n    test("rejects garbage"`,
    );
    expect(changed(CRON_BASE, head)).toEqual(["parser > invalid expression > rejects duplicated zero values"]);
  });

  it("reports only the duplicate-named test whose body actually changed", () => {
    const head = CRON_BASE.replace(`toEqual([0, 2, 4])`, `toEqual([0, 2, 4, 6])`);
    const result = compareTestFile(FILE, analyzeTestSource(CRON_BASE, FILE), analyzeTestSource(head, FILE)).changedTests;
    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(3);
  });

  it("still treats runtime-named tests as changed when their loop data changes", () => {
    const head = CRON_BASE.replace(`["0 0 L * *", "0 0 L-1 * *"]`, `["0 0 L * *", "0 0 L-1 * *", "0 0 L-2 * *"]`);
    const result = compareTestFile(FILE, analyzeTestSource(CRON_BASE, FILE), analyzeTestSource(head, FILE)).changedTests;
    expect(result).toHaveLength(1);
    expect(result[0]?.dynamicName).toBe(true);
    expect(result[0]?.namePath.slice(0, 2)).toEqual(["parser", "last of flag"]);
  });

  it("still treats table tests as changed when a table row changes, and not otherwise", () => {
    const base = `describe("withBase", () => {
  it.each([["/", "/api"], ["/a", "/api/a"]])("joins %s", (input, out) => { expect(withBase(input, "/api")).toBe(out); });
  it("static", () => { expect(1 + 1).toBe(2); });
});
`;
    const rowAdded = base.replace(`["/a", "/api/a"]]`, `["/a", "/api/a"], ["/api2", "/api/api2"]]`);
    expect(changed(base, rowAdded)).toEqual(["withBase > joins %s"]);
    const staticChanged = base.replace("toBe(2)", "toBe(2);\n    expect(2 + 2).toBe(4)");
    expect(changed(base, staticChanged)).toEqual(["withBase > static"]);
  });

  it("attributes a change in a suite's shared case data to that suite's runtime-named tests only", () => {
    const base = `describe("withBase", () => {
  const cases = [{ input: "/", out: "/api" }];
  for (const t of cases) {
    it(t.input + " -> " + t.out, () => { expect(withBase(t.input, "/api")).toBe(t.out); });
  }
  it("keeps static tests", () => { expect(withBase("", "/api")).toBe("/api"); });
});
describe("withoutBase", () => {
  const cases = [{ input: "/api", out: "/" }];
  for (const t of cases) {
    it(t.input + " -> " + t.out, () => { expect(withoutBase(t.input, "/api")).toBe(t.out); });
  }
});
`;
    const head = base.replace(`[{ input: "/", out: "/api" }]`, `[{ input: "/", out: "/api" }, { input: "/apiary", out: "/api/apiary" }]`);
    const result = changed(base, head);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^withBase > <dynamic /);
  });

  it("keeps unique static tests unchanged when only suite-level declarations change (no wider attribution than before)", () => {
    const base = `describe("s", () => {\n  const fixture = { a: 1 };\n  it("reads a", () => { expect(fixture.a).toBe(1); });\n});\n`;
    const head = base.replace("{ a: 1 }", "{ a: 1, b: 2 }");
    expect(changed(base, head)).toEqual([]);
  });
});

describe("BigInt literals (D2)", () => {
  it("analyses test files containing BigInt literals without crashing", () => {
    const base = `describe("big", () => {\n  it("adds", () => { expect(add(1n, 2n)).toBe(3n); });\n});\n`;
    const head = base.replace("toBe(3n)", "toBe(3n);\n    expect(add(10n ** 20n, 1n)).toBe(100000000000000000001n)");
    const result = compareTestFile(FILE, analyzeTestSource(base, FILE), analyzeTestSource(head, FILE));
    expect(result.changedTests.map((t) => t.namePath.join(" > "))).toEqual(["big > adds"]);
    expect(result.findings).toEqual([]);
  });

  it("serialises BigInt values deterministically and never like the equivalent number or string", () => {
    const expr = (code: string) => {
      const statement = parseSource(`${code};`, "x.ts").program.body[0];
      return canonical(statement);
    };
    expect(expr("10n")).toBe(expr("10n"));
    expect(expr("0x0An")).toBe(expr("10n"));
    expect(expr("10n")).not.toBe(expr("10"));
    expect(expr("10n")).not.toBe(expr('"10"'));
    expect(expr("10n")).not.toBe(expr('"10n"'));
    expect(expr("[1n, 2n]")).not.toBe(expr("[1, 2]"));
  });
});
