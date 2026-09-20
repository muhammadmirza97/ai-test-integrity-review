import { describe, expect, it } from "vitest";
import type { RawFinding } from "../../src/domain/finding.js";
import { DEFAULT_CONFIG } from "../../src/config/parse.js";
import { compareWorkflow } from "../../src/rules/workflow-integrity.js";

const FILE = ".github/workflows/merge-integrity.yml";
const rules = (findings: RawFinding[]) => findings.map((f) => f.ruleId).sort();

const BASE = `name: Merge Integrity
on:
  pull_request:
  merge_group:
permissions:
  contents: read
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - run: npm ci
      - uses: example/merge-integrity-action@v1
        with:
          config-source: base
`;

/** The Action is published as `ai-test-integrity-review`; the older `merge-integrity` name must keep working. */
const PUBLISHED = BASE.replace("example/merge-integrity-action@v1", "muhammadmirza97/ai-test-integrity-review@v0.1.0-alpha.1");

describe("workflow integrity (structural YAML comparison)", () => {
  it("recognises the published Action name as the gate", () => {
    expect(rules(compareWorkflow(FILE, PUBLISHED, PUBLISHED.replace(/ {6}- uses: muhammadmirza97[\s\S]*$/, "")))).toEqual(["MI005_TEST_COMMAND_BYPASS"]);
    expect(rules(compareWorkflow(FILE, PUBLISHED, PUBLISHED.replace("config-source: base", "red-green: false")))).toEqual(["MI106_POLICY_WEAKENED"]);
    expect(compareWorkflow(FILE, PUBLISHED, PUBLISHED)).toEqual([]);
  });

  it("defaults MI106 to block", () => {
    expect(DEFAULT_CONFIG.rules.MI106_POLICY_WEAKENED).toBe("block");
  });

  it("does not flag unrelated workflow edits", () => {
    expect(compareWorkflow(FILE, BASE, BASE.replace("npm ci", "npm ci --ignore-scripts"))).toEqual([]);
    expect(compareWorkflow(FILE, BASE, `${BASE}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`)).toEqual([]);
    expect(compareWorkflow(".github/workflows/release.yml", "name: r\non: push\njobs: {}\n", undefined)).toEqual([]);
  });

  describe("the compatibility preflight is not a gate", () => {
    const PREFLIGHT = `name: Merge Integrity preflight
on: workflow_dispatch
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: example/merge-integrity-action@v1
        with:
          mode: doctor
`;

    it("does not report adding, changing or deleting a preflight workflow", () => {
      const file = ".github/workflows/merge-integrity-preflight.yml";
      expect(compareWorkflow(file, PREFLIGHT, undefined)).toEqual([]);
      expect(compareWorkflow(file, PREFLIGHT, PREFLIGHT.replace("example/merge-integrity-action@v1", "example/merge-integrity-action@v2"))).toEqual([]);
      expect(compareWorkflow(file, undefined, PREFLIGHT)).toEqual([]);
    });

    it("BLOCKs turning the real gate into a preflight", () => {
      const head = BASE.replace("        with:\n          config-source: base\n", "        with:\n          mode: doctor\n");
      expect(rules(compareWorkflow(FILE, BASE, head))).toEqual(["MI005_TEST_COMMAND_BYPASS"]);
    });
  });

  it("BLOCKs removing the gate step, commenting it out, or deleting the workflow", () => {
    expect(rules(compareWorkflow(FILE, BASE, BASE.replace(/ {6}- uses: example[\s\S]*$/, "")))).toEqual(["MI005_TEST_COMMAND_BYPASS"]);
    expect(rules(compareWorkflow(FILE, BASE, BASE.replace("      - uses: example/merge-integrity-action@v1\n        with:\n          config-source: base\n", "      # - uses: example/merge-integrity-action@v1\n")))).toEqual([
      "MI005_TEST_COMMAND_BYPASS",
    ]);
    expect(rules(compareWorkflow(FILE, BASE, undefined))).toEqual(["MI005_TEST_COMMAND_BYPASS"]);
  });

  it("is not fooled by the gate name appearing in a comment, name or echo", () => {
    const head = BASE.replace("      - uses: example/merge-integrity-action@v1\n        with:\n          config-source: base\n", "      - name: merge-integrity\n        run: echo merge-integrity skipped\n");
    expect(rules(compareWorkflow(FILE, BASE, head))).toEqual(["MI005_TEST_COMMAND_BYPASS"]);
  });

  it.each([
    ["config-source: head", BASE.replace("config-source: base", "config-source: head")],
    ["red-green: false", BASE.replace("config-source: base", "config-source: base\n          red-green: false")],
    ["mutation: false (quoted)", BASE.replace("config-source: base", 'mutation: "false"')],
    ["base-ref override", BASE.replace("config-source: base", "base-ref: ${{ github.sha }}")],
    ["working-directory override", BASE.replace("config-source: base", "working-directory: docs")],
    ["step continue-on-error", BASE.replace("      - uses: example/merge-integrity-action@v1\n", "      - uses: example/merge-integrity-action@v1\n        continue-on-error: true\n")],
    ["job continue-on-error", BASE.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    continue-on-error: true\n")],
    ["step if condition", BASE.replace("      - uses: example/merge-integrity-action@v1\n", "      - uses: example/merge-integrity-action@v1\n        if: github.actor != 'bot'\n")],
    ["job if condition", BASE.replace("    runs-on: ubuntu-latest\n", "    if: false\n    runs-on: ubuntu-latest\n")],
    ["pull_request trigger removed", BASE.replace("  pull_request:\n", "")],
    ["pull_request paths filter added", BASE.replace("  pull_request:\n", "  pull_request:\n    paths: ['docs/**']\n")],
    ["action replaced by another repository", BASE.replace("example/merge-integrity-action@v1", "attacker/merge-integrity-action@v1")],
    ["flow-style YAML hiding red-green false", BASE.replace("        with:\n          config-source: base\n", "        with: { config-source: base, red-green: false }\n")],
  ])("BLOCKs a gate bypass: %s", (_name, head) => {
    expect(rules(compareWorkflow(FILE, BASE, head))).toEqual(["MI106_POLICY_WEAKENED"]);
  });

  it("WARNs (not BLOCKs) when only the pinned version of the same Action changes", () => {
    expect(rules(compareWorkflow(FILE, BASE, BASE.replace("action@v1", "action@0123456789abcdef0123456789abcdef01234567")))).toEqual([
      "MI101_ASSERTION_CHANGE_AMBIGUOUS",
    ]);
  });

  it("BLOCKs when a workflow that ran the gate can no longer be parsed", () => {
    expect(rules(compareWorkflow(FILE, BASE, "jobs: [unclosed\n"))).toEqual(["MI106_POLICY_WEAKENED"]);
  });

  it("detects a CLI-based gate run step", () => {
    const cliBase = BASE.replace("      - uses: example/merge-integrity-action@v1\n        with:\n          config-source: base\n", "      - run: npx merge-integrity check --base origin/main\n");
    const head = cliBase.replace("npx merge-integrity check --base origin/main", "npx merge-integrity check --base origin/main || true");
    expect(rules(compareWorkflow(FILE, cliBase, head))).toEqual(["MI106_POLICY_WEAKENED"]);
  });
});
