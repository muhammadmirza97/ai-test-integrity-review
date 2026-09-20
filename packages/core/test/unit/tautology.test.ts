import { describe, expect, it } from "vitest";
import { analyzeTestSource } from "../../src/ast/tests.js";
import { compareTestFile, isTautology } from "../../src/rules/test-integrity.js";

function assertionOf(code: string) {
  const model = analyzeTestSource(`it("t", () => { ${code}; });\n`, "a.test.ts");
  const assertion = model.blocks[0]?.assertions[0];
  if (!assertion) throw new Error(`no assertion parsed from ${code}`);
  return assertion;
}

describe("isTautology", () => {
  it.each([
    "expect(true).toBe(true)",
    "expect(1).toBe(1)",
    'expect("a").toEqual("a")',
    "expect(null).toStrictEqual(null)",
    "expect(1).not.toBe(2)",
    "expect(true).toBeTruthy()",
    "expect(0).toBeFalsy()",
    "expect(1).toBeDefined()",
    "expect(undefined).toBeUndefined()",
    "expect(null).toBeNull()",
    "expect(x).toBe(x)",
    "assert(true)",
    "assert.ok(1)",
    "assert.equal(1, 1)",
    "assert.strictEqual('a', 'a')",
  ])("%s is always true", (code) => {
    expect(isTautology(assertionOf(code))).toBe(true);
  });

  it.each([
    "expect(1).toBe(2)",
    "expect(false).toBe(true)",
    'expect("a").toEqual("b")',
    "expect(1).not.toBe(1)",
    "expect(false).toBeTruthy()",
    "expect(1).toBeFalsy()",
    "expect(undefined).toBeDefined()",
    "expect(1).toBeNull()",
    "expect(x).not.toBe(x)",
    "expect(x).toBe(1)",
    "expect(1).toBeGreaterThan(0)",
    "assert(false)",
    "assert.equal(1, 2)",
    "assert.notEqual(1, 1)",
  ])("%s is not a tautology", (code) => {
    expect(isTautology(assertionOf(code))).toBe(false);
  });
});

describe("assertion removal with literal assertions", () => {
  const base = `it("t", () => {\n  expect(compute()).toBe(3);\n});\n`;
  const compare = (head: string) =>
    compareTestFile("a.test.ts", analyzeTestSource(base, "a.test.ts"), analyzeTestSource(head, "a.test.ts")).findings.map((f) => f.ruleId);

  it("BLOCKs when the only replacement is always true", () => {
    expect(compare(`it("t", () => {\n  compute();\n  expect(1).toBe(1);\n});\n`)).toEqual(["MI003_ASSERTION_REMOVED"]);
  });

  it("treats a constant contradiction as a real (failing) assertion, not as a tautology", () => {
    // expect(1).toBe(2) fails on every run; it is not a free pass. It replaces the removed assertion one-for-one,
    // and the test cannot pass on head, so red/green reports ERROR rather than PASS.
    expect(isTautology(assertionOf("expect(1).toBe(2)"))).toBe(false);
    expect(compare(`it("t", () => {\n  compute();\n  expect(1).toBe(2);\n});\n`)).not.toContain("MI003_ASSERTION_REMOVED");
  });
});
