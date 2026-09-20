import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceParseError } from "../../src/ast/parse.js";
import { analyzeTestSource } from "../../src/ast/tests.js";
import { RULE_IDS } from "../../src/domain/finding.js";
import { compareTestFile } from "../../src/rules/test-integrity.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rules");

interface Expected {
  polarity: "positive" | "negative" | "ambiguous" | "error";
  ext: string;
  expect: Record<string, number>;
  expectError?: boolean;
}

const cases = readdirSync(FIXTURES).sort();

describe("rule fixtures", () => {
  it("covers positive and negative cases for every deterministic BLOCK rule", () => {
    for (const rule of ["mi001", "mi002", "mi003", "mi004"]) {
      expect(cases.some((c) => c.startsWith(`${rule}-positive`)), `${rule} positive`).toBe(true);
      expect(cases.some((c) => c.startsWith(`${rule}-negative`)), `${rule} negative`).toBe(true);
    }
  });

  for (const name of cases) {
    it(name, () => {
      const dir = join(FIXTURES, name);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
      const file = `test/example.test.${expected.ext}`;
      const read = (which: "base" | "head") => {
        const path = join(dir, `${which}.${expected.ext}`);
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      };

      const analyze = () => {
        const baseText = read("base");
        const headText = read("head");
        return compareTestFile(
          file,
          baseText === undefined ? undefined : analyzeTestSource(baseText, file),
          headText === undefined ? undefined : analyzeTestSource(headText, file),
        );
      };

      if (expected.expectError) {
        expect(analyze).toThrow(SourceParseError);
        return;
      }
      const result = analyze();
      const counts = Object.fromEntries(RULE_IDS.map((id) => [id, result.findings.filter((f) => f.ruleId === id).length]));
      const wanted = Object.fromEntries(RULE_IDS.map((id) => [id, expected.expect[id] ?? 0]));
      expect(counts, JSON.stringify(result.findings, null, 2)).toEqual(wanted);
      if (expected.polarity === "negative" || expected.polarity === "ambiguous") {
        expect(result.findings.filter((f) => f.ruleId.startsWith("MI00"))).toEqual([]);
      }
    });
  }
});
