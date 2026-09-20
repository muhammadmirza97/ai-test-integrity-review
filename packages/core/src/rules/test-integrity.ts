import type { AssertionModel, TestBlock, TestFileModel } from "../ast/tests.js";
import type { RawFinding } from "../domain/finding.js";

/**
 * Deterministic comparison of one test file between the merge base and the PR head.
 *
 * Confidence discipline: MI001/MI002 are purely syntactic and always high confidence.
 * MI004 BLOCKs only for uniquely matched tests with reviewed transformations; MI003 (assertion removed) is advisory by
 * default because removals are often deliberate (feature or platform removal). Anything less certain is reported as
 * MI101 (WARN) or not at all.
 */
export interface TestFileComparison {
  findings: RawFinding[];
  /** Base tests with no counterpart in head (candidates for MI104 after cross-file move detection). */
  removedTests: TestBlock[];
  /** Head tests with no counterpart in base. */
  addedTests: TestBlock[];
  /** Tests whose body changed or that were added (used to decide red/green applicability). */
  materiallyChanged: boolean;
  /** Changed or added runnable test cases in head, identified by suite path + name. */
  changedTests: ChangedTest[];
}

export interface ChangedTest {
  namePath: string[];
  line: number;
  /** Name cannot be matched to runtime results (template/table/dynamic names). */
  dynamicName: boolean;
}

const EXACT = new Set(["toBe", "toEqual", "toStrictEqual"]);
const CALLED_SPECIFIC = new Set([
  "toHaveBeenCalledWith",
  "toHaveBeenCalledTimes",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledExactlyOnceWith",
  "toBeCalledWith",
  "toBeCalledTimes",
  "lastCalledWith",
  "nthCalledWith",
]);
const CALLED_GENERIC = new Set(["toHaveBeenCalled", "toBeCalled"]);
const SPECIFIC_NO_ARG = new Set(["toBeNull", "toBeUndefined", "toBeNaN"]);
const SPECIFIC_WITH_ARG = new Set([
  ...EXACT,
  "toHaveLength",
  "toContain",
  "toContainEqual",
  "toMatch",
  "toMatchObject",
  "toHaveProperty",
  "toBeCloseTo",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeInstanceOf",
  "toBeTypeOf",
  "toSatisfy",
  "toHaveReturnedWith",
  "toHaveReturnedTimes",
  "toThrow",
  "toThrowError",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
  ...CALLED_SPECIFIC,
]);
/** Presence-only matchers: they accept almost any value. */
const GENERIC_IDS = new Set(["toBeDefined", "toBeTruthy", "toBeFalsy", "not.toBeUndefined", "not.toBeNull"]);

function matcherId(a: AssertionModel): string {
  return `${a.negated ? "not." : ""}${a.matcher}`;
}

function isSpecific(a: AssertionModel): boolean {
  if (a.style !== "expect" || a.negated) return false;
  return SPECIFIC_NO_ARG.has(a.matcher) || (SPECIFIC_WITH_ARG.has(a.matcher) && a.args.length > 0) || a.matcher.includes("Snapshot");
}

function isGeneric(a: AssertionModel): boolean {
  if (a.style !== "expect") return false;
  return (
    GENERIC_IDS.has(matcherId(a)) ||
    (!a.negated && CALLED_GENERIC.has(a.matcher)) ||
    (!a.negated && (a.matcher === "toThrow" || a.matcher === "toThrowError") && a.args.length === 0)
  );
}

/** `expect(true).toBe(true)`, `expect(1).toBeTruthy()`, `expect(x).toBe(x)`: assertions that cannot fail. */
export function isTautology(a: AssertionModel): boolean {
  if (a.style === "meta" || a.subject === "") return false;

  // Same expression on both sides: `expect(x).toBe(x)`.
  if (a.style === "expect" && a.args.length === 1 && a.args[0] === a.subject && EXACT.has(a.matcher)) return !a.negated;

  const subject = a.subjectLiterals.length === 1 ? a.subjectLiterals[0] : null;
  if (!subject) return false;
  const arg = a.argLiterals.length === 1 ? a.argLiterals[0] : null;
  const verdict = evaluateLiteralAssertion(a, subject.value, arg);
  return verdict === true;
}

/** Evaluate an assertion whose operands are literals. `undefined` when the matcher is not modelled. */
function evaluateLiteralAssertion(a: AssertionModel, value: unknown, arg: { value: unknown } | null | undefined): boolean | undefined {
  if (a.style === "expect") {
    let result: boolean | undefined;
    if (EXACT.has(a.matcher) && a.args.length === 1 && arg) result = Object.is(value, arg.value);
    else if (a.args.length === 0) {
      if (a.matcher === "toBeTruthy") result = Boolean(value);
      else if (a.matcher === "toBeFalsy") result = !value;
      else if (a.matcher === "toBeDefined") result = value !== undefined;
      else if (a.matcher === "toBeUndefined") result = value === undefined;
      else if (a.matcher === "toBeNull") result = value === null;
    }
    return result === undefined ? undefined : a.negated ? !result : result;
  }
  if (a.style === "assert") {
    if ((a.matcher === "assert" || a.matcher === "ok") && a.args.length === 0) return Boolean(value);
    if (!arg || a.args.length !== 1) return undefined;
    // Loose equality is deliberately evaluated as strict: only identical literals count as always true.
    if (["equal", "strictEqual", "deepEqual", "deepStrictEqual"].includes(a.matcher)) return Object.is(value, arg.value);
    if (["notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual"].includes(a.matcher)) return !Object.is(value, arg.value);
  }
  return undefined;
}

function satisfies(generic: string, value: unknown): boolean {
  switch (generic) {
    case "toBeDefined":
    case "not.toBeUndefined":
      return value !== undefined;
    case "toBeTruthy":
      return Boolean(value);
    case "toBeFalsy":
      return !value;
    case "not.toBeNull":
      return value !== null;
    default:
      return true;
  }
}

type ChangeClass = "weakened" | "possibly-weaker" | "neutral";

/** Reviewed transformation table. Only entries here may produce MI004. */
export function classifyAssertionChange(before: AssertionModel, after: AssertionModel): { kind: ChangeClass; reason: string } {
  const from = matcherId(before);
  const to = matcherId(after);
  if (before.style === "expect" && after.style === "expect") {
    if (GENERIC_IDS.has(to) && !GENERIC_IDS.has(from)) {
      let literal: { value: unknown } | null = null;
      if (EXACT.has(from) && before.args.length === 1) literal = before.argLiterals[0] ?? null;
      if (from === "toBeNull") literal = { value: null };
      if (from === "toBeUndefined") literal = { value: undefined };
      if (from === "toBeNaN") literal = { value: Number.NaN };
      if (literal && !satisfies(to, literal.value)) {
        return { kind: "neutral", reason: "expectation reversed rather than weakened" };
      }
      if (isSpecific(before)) return { kind: "weakened", reason: `${from}(...) replaced by generic ${to}()` };
      return { kind: "possibly-weaker", reason: `${from} replaced by generic ${to}()` };
    }
    if (CALLED_SPECIFIC.has(from) && CALLED_GENERIC.has(to) && !before.negated && !after.negated) {
      const times = before.argLiterals[0];
      if ((from === "toHaveBeenCalledTimes" || from === "toBeCalledTimes") && times && times.value === 0) {
        return { kind: "neutral", reason: "expectation reversed rather than weakened" };
      }
      return { kind: "weakened", reason: `${from}(...) replaced by ${to}() without checking arguments or call count` };
    }
    if (
      (from === "toThrow" || from === "toThrowError") &&
      (to === "toThrow" || to === "toThrowError") &&
      before.args.length > 0 &&
      after.args.length === 0
    ) {
      return { kind: "weakened", reason: `${from}(expected) replaced by ${to}() which accepts any error` };
    }
    if (
      from === "toHaveProperty" &&
      to === "toHaveProperty" &&
      before.args.length >= 2 &&
      after.args.length === 1 &&
      before.args[0] === after.args[0]
    ) {
      return { kind: "weakened", reason: "toHaveProperty(key, value) replaced by toHaveProperty(key) without checking the value" };
    }
    if (EXACT.has(from) && to === "toMatchObject") {
      return { kind: "possibly-weaker", reason: `${from} replaced by partial match toMatchObject` };
    }
    if (from === "toStrictEqual" && (to === "toEqual" || to === "toBe") && before.args.join() === after.args.join()) {
      return { kind: "possibly-weaker", reason: "toStrictEqual relaxed to a looser equality" };
    }
    return { kind: "neutral", reason: "not a reviewed weakening transformation" };
  }
  const weakTargets = new Set(["ok", "assert", "exist", "exists", "true", "defined"]);
  if (before.matcher !== after.matcher && weakTargets.has(after.matcher) && !weakTargets.has(before.matcher)) {
    return { kind: "possibly-weaker", reason: `${before.matcher} replaced by ${after.matcher}` };
  }
  return { kind: "neutral", reason: "not a reviewed weakening transformation" };
}

function multisetDifference(left: AssertionModel[], right: AssertionModel[]): AssertionModel[] {
  const counts = new Map<string, number>();
  for (const a of right) counts.set(a.signature, (counts.get(a.signature) ?? 0) + 1);
  const result: AssertionModel[] = [];
  for (const a of left) {
    const n = counts.get(a.signature) ?? 0;
    if (n > 0) counts.set(a.signature, n - 1);
    else result.push(a);
  }
  return result;
}

function pairKey(a: AssertionModel): string {
  return JSON.stringify([a.style, a.subject, a.modifiers]);
}

function describeTest(block: TestBlock): string {
  const path = [...block.path, block.name].map((n) => JSON.stringify(n)).join(" > ");
  return block.kind === "hook" ? `hook ${path}` : block.kind === "suite" ? `suite ${path}` : `test ${path}`;
}

function compareAssertions(
  file: string,
  base: TestBlock,
  head: TestBlock,
  confidence: "high" | "low",
  findings: RawFinding[],
): void {
  const baseAssertions = base.assertions.filter((a) => a.style !== "meta" && !isTautology(a));
  const headAssertions = head.assertions.filter((a) => a.style !== "meta" && !isTautology(a));
  const tautologiesAdded = head.assertions.filter(isTautology).length > base.assertions.filter(isTautology).length;

  const baseMeta = base.assertions.filter((a) => a.style === "meta").length;
  const headMeta = head.assertions.filter((a) => a.style === "meta").length;
  if (headMeta < baseMeta) {
    findings.push({
      ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
      file,
      startLine: head.line,
      message: `In ${describeTest(head)}, expect.assertions()/expect.hasAssertions() was removed; asynchronous assertions may no longer be enforced.`,
    });
  }

  const removed = multisetDifference(baseAssertions, headAssertions);
  if (removed.length === 0) return;
  const added = multisetDifference(headAssertions, baseAssertions);

  const removedByKey = new Map<string, AssertionModel[]>();
  const addedByKey = new Map<string, AssertionModel[]>();
  for (const a of removed) removedByKey.set(pairKey(a), [...(removedByKey.get(pairKey(a)) ?? []), a]);
  for (const a of added) addedByKey.set(pairKey(a), [...(addedByKey.get(pairKey(a)) ?? []), a]);

  const pairedRemoved = new Set<AssertionModel>();
  const pairedAdded = new Set<AssertionModel>();
  for (const [key, removedGroup] of removedByKey) {
    const addedGroup = addedByKey.get(key);
    if (removedGroup.length !== 1 || addedGroup?.length !== 1) continue;
    const before = removedGroup[0] as AssertionModel;
    const after = addedGroup[0] as AssertionModel;
    pairedRemoved.add(before);
    pairedAdded.add(after);
    const change = classifyAssertionChange(before, after);
    if (change.kind === "neutral") continue;
    const block = change.kind === "weakened" && confidence === "high";
    findings.push({
      ruleId: block ? "MI004_ASSERTION_WEAKENED" : "MI101_ASSERTION_CHANGE_AMBIGUOUS",
      file,
      startLine: after.line,
      message: `In ${describeTest(head)}, \`${before.text}\` became \`${after.text}\` (${change.reason}).`,
      evidence: { before: before.text, after: after.text, confidence },
    });
  }

  const remainingRemoved = removed.filter((a) => !pairedRemoved.has(a));
  const remainingAdded = added.filter((a) => !pairedAdded.has(a));
  if (remainingRemoved.length === 0) return;

  const removedText = remainingRemoved.map((a) => `\`${a.text}\``).join(", ");
  if (remainingAdded.length === 0) {
    const baseCalls = new Set(base.calls);
    const newCalls = head.calls.filter((c) => !baseCalls.has(c));
    if (confidence === "high" && newCalls.length === 0) {
      findings.push({
        ruleId: "MI003_ASSERTION_REMOVED",
        file,
        startLine: head.line,
        message: `In ${describeTest(head)}, ${remainingRemoved.length} assertion(s) were removed with no replacement: ${removedText}${tautologiesAdded ? " (only always-true assertions were added)" : ""}.`,
        evidence: { removed: remainingRemoved.map((a) => a.text), confidence },
      });
    } else {
      findings.push({
        ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
        file,
        startLine: head.line,
        message: `In ${describeTest(head)}, assertion(s) were removed (${removedText}); ${
          newCalls.length > 0 ? `new calls (${newCalls.slice(0, 5).join(", ")}) may contain replacement assertions` : "the test could not be matched with certainty"
        }.`,
        evidence: { removed: remainingRemoved.map((a) => a.text), newCalls, confidence },
      });
    }
    return;
  }

  const allGeneric = remainingAdded.every(isGeneric);
  if ((allGeneric && remainingRemoved.some(isSpecific)) || remainingAdded.length < remainingRemoved.length) {
    findings.push({
      ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
      file,
      startLine: head.line,
      message: `In ${describeTest(head)}, ${remainingRemoved.length} assertion(s) were replaced by ${remainingAdded.length} ${
        allGeneric ? "less specific " : ""
      }assertion(s); equivalence could not be confirmed.`,
      evidence: { removed: remainingRemoved.map((a) => a.text), added: remainingAdded.map((a) => a.text), confidence },
    });
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function excessMarkers(
  baseBlocks: TestBlock[],
  headBlocks: TestBlock[],
  predicate: (block: TestBlock) => boolean,
): TestBlock[] {
  const baseCounts = countBy(baseBlocks.filter(predicate), (b) => b.key);
  const result: TestBlock[] = [];
  for (const [key, heads] of countBy(headBlocks.filter(predicate), (b) => b.key)) {
    const baseCount = baseCounts.get(key)?.length ?? 0;
    result.push(...heads.slice(baseCount));
  }
  return result;
}

export function compareTestFile(file: string, base: TestFileModel | undefined, head: TestFileModel | undefined): TestFileComparison {
  const findings: RawFinding[] = [];
  const baseBlocks = base?.blocks ?? [];
  const headBlocks = head?.blocks ?? [];

  if (head) {
    for (const block of excessMarkers(baseBlocks, headBlocks, (b) => b.focused)) {
      findings.push({
        ruleId: "MI002_TEST_FOCUSED",
        file,
        startLine: block.line,
        message: `${describeTest(block)} is focused with \`${block.api}\`; every other test in the file is silently excluded.`,
      });
    }
    for (const block of excessMarkers(baseBlocks, headBlocks, (b) => b.skip === "unconditional" && !b.todo)) {
      findings.push({
        ruleId: "MI001_TEST_SKIPPED",
        file,
        startLine: block.line,
        message: `${describeTest(block)} is skipped with \`${block.api}\` and no longer runs.`,
      });
    }
    const baseRunnableKeys = new Set(baseBlocks.filter((b) => !b.todo && b.hasCallback).map((b) => b.key));
    for (const block of excessMarkers(baseBlocks, headBlocks, (b) => b.todo)) {
      if (!baseRunnableKeys.has(block.key)) continue;
      findings.push({
        ruleId: "MI001_TEST_SKIPPED",
        file,
        startLine: block.line,
        message: `${describeTest(block)} was converted to \`${block.api}\` and no longer runs.`,
      });
    }
    for (const block of excessMarkers(baseBlocks, headBlocks, (b) => b.skip === "conditional")) {
      findings.push({
        ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
        file,
        startLine: block.line,
        message: `${describeTest(block)} now runs conditionally (\`${block.api}\`); it may be skipped in CI.`,
      });
    }
    for (const block of excessMarkers(baseBlocks, headBlocks, (b) => b.inverted)) {
      findings.push({
        ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
        file,
        startLine: block.line,
        message: `${describeTest(block)} is now expected to fail (\`${block.api}\`).`,
      });
    }
  }

  // Match runnable blocks (tests and hooks) across revisions.
  const runnable = (b: TestBlock) => b.kind !== "suite";
  const baseByKey = countBy(baseBlocks.filter(runnable), (b) => b.key);
  const headByKey = countBy(headBlocks.filter(runnable), (b) => b.key);
  const pairs: { base: TestBlock; head: TestBlock; confidence: "high" | "low" }[] = [];
  const unmatchedBase: TestBlock[] = [];
  const unmatchedHead: TestBlock[] = [];
  for (const [key, bases] of baseByKey) {
    const heads = headByKey.get(key) ?? [];
    const confidence = bases.length === 1 && heads.length === 1 && !bases[0]?.dynamicName ? "high" : "low";
    const n = Math.min(bases.length, heads.length);
    for (let i = 0; i < n; i++) pairs.push({ base: bases[i] as TestBlock, head: heads[i] as TestBlock, confidence });
    unmatchedBase.push(...bases.slice(n));
  }
  for (const [key, heads] of headByKey) {
    const n = baseByKey.get(key)?.length ?? 0;
    unmatchedHead.push(...heads.slice(n));
  }

  // Rename heuristic: a single removed and a single added test in the same suite. Always low confidence.
  const unmatchedBaseByPath = countBy(unmatchedBase.filter((b) => b.kind === "test"), (b) => JSON.stringify(b.path));
  const unmatchedHeadByPath = countBy(unmatchedHead.filter((b) => b.kind === "test"), (b) => JSON.stringify(b.path));
  const renamed = new Set<TestBlock>();
  for (const [path, bases] of unmatchedBaseByPath) {
    const heads = unmatchedHeadByPath.get(path);
    if (bases.length === 1 && heads?.length === 1) {
      pairs.push({ base: bases[0] as TestBlock, head: heads[0] as TestBlock, confidence: "low" });
      renamed.add(bases[0] as TestBlock).add(heads[0] as TestBlock);
    }
  }

  let materiallyChanged = unmatchedHead.some((b) => b.kind === "test" && b.hasCallback && !b.todo);
  const skippedInBase = effectiveSkips(baseBlocks);
  for (const pair of pairs) {
    if (pair.base.bodySignature !== pair.head.bodySignature) materiallyChanged = true;
    if (skippedInBase.has(pair.base) || pair.base.todo || pair.head.todo) continue;
    if (pair.head.skip === "unconditional") continue; // reported by MI001
    compareAssertions(file, pair.base, pair.head, pair.confidence, findings);
  }

  // Changed test cases for red/green: added, renamed or changed runnable tests in head. A changed hook affects every
  // test in its suite, so those tests are included too. A head block is unchanged when an unused base block with the
  // same key has the same fingerprint (compared as a multiset, so duplicate names match each other). For blocks whose
  // identity is not unique the fingerprint includes their context (loop data, tables, suite declarations), so a change
  // there still counts, but an unrelated change elsewhere in the file does not.
  const skippedInHead = effectiveSkips(headBlocks);
  const runnableHead = (b: TestBlock) => b.kind === "test" && b.hasCallback && !b.todo && !skippedInHead.has(b);
  const fingerprint = (b: TestBlock) => `${b.bodySignature}\0${b.contextSignature}`;
  const changed = new Set<TestBlock>();
  const changedHooks: TestBlock[] = [];
  for (const [key, heads] of headByKey) {
    const available = new Map<string, number>();
    for (const base of baseByKey.get(key) ?? []) available.set(fingerprint(base), (available.get(fingerprint(base)) ?? 0) + 1);
    for (const head of heads) {
      const left = available.get(fingerprint(head)) ?? 0;
      if (left > 0) {
        available.set(fingerprint(head), left - 1);
        continue;
      }
      if (head.kind === "hook") changedHooks.push(head);
      else if (runnableHead(head)) changed.add(head);
    }
  }
  if (changed.size > 0 || changedHooks.length > 0) materiallyChanged = true;
  for (const hook of changedHooks) {
    for (const block of headBlocks) {
      if (runnableHead(block) && hook.path.every((p, i) => block.path[i] === p)) changed.add(block);
    }
  }

  return {
    findings,
    removedTests: unmatchedBase.filter((b) => !renamed.has(b) && b.kind === "test" && b.hasCallback && !b.todo && !skippedInBase.has(b)),
    addedTests: unmatchedHead.filter((b) => !renamed.has(b) && b.kind === "test"),
    materiallyChanged,
    changedTests: headBlocks
      .filter((b) => changed.has(b))
      .map((b) => ({ namePath: [...b.path, b.name], line: b.line, dynamicName: b.dynamicName || b.table || b.path.some((p) => p.startsWith("<dynamic ")) })),
  };
}

/** Blocks that do not run because they or an enclosing suite are unconditionally skipped. */
function effectiveSkips(blocks: TestBlock[]): Set<TestBlock> {
  const skippedSuites = blocks.filter((b) => b.kind === "suite" && (b.skip === "unconditional" || b.todo));
  const result = new Set<TestBlock>();
  for (const block of blocks) {
    if (block.skip === "unconditional") {
      result.add(block);
      continue;
    }
    for (const suite of skippedSuites) {
      const suitePath = [...suite.path, suite.name];
      if (block.path.length >= suitePath.length && suitePath.every((p, i) => block.path[i] === p)) {
        result.add(block);
        break;
      }
    }
  }
  return result;
}
