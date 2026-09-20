import { cpus } from "node:os";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MutantResult } from "../domain/result.js";
import { findInstalledPackage } from "../framework/resolve.js";
import { runProcess } from "../process/run.js";
import { MutationError, type MutationAdapter, type MutationRunArgs, type MutationRunResult } from "./adapter.js";
import { ENUMERATOR_SCRIPT } from "./enumerator-script.js";

/** 0-based line, 0-based column (Stryker API convention). */
interface Position {
  line: number;
  column: number;
}

export interface PlannedMutant {
  file: string;
  mutatorName: string;
  replacement: string;
  start: Position;
  end: Position;
}

const GLOB_SPECIAL = /[*?[\]{}()!+@\\]/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function key(file: string, mutatorName: string, replacement: string, start: Position, end: Position): string {
  return JSON.stringify([file, mutatorName, replacement, start.line, start.column, end.line, end.column]);
}

function contains(outer: { start: Position; end: Position }, inner: { start: Position; end: Position }): boolean {
  const startOk = outer.start.line < inner.start.line || (outer.start.line === inner.start.line && outer.start.column <= inner.start.column);
  const endOk = outer.end.line > inner.end.line || (outer.end.line === inner.end.line && outer.end.column >= inner.end.column);
  return startOk && endOk;
}

function compareMutants(a: PlannedMutant, b: PlannedMutant): number {
  return (
    a.file.localeCompare(b.file) ||
    a.start.line - b.start.line ||
    a.start.column - b.start.column ||
    a.end.line - b.end.line ||
    a.end.column - b.end.column ||
    a.mutatorName.localeCompare(b.mutatorName) ||
    a.replacement.localeCompare(b.replacement)
  );
}

/**
 * Choose Stryker `mutate` ranges so that exactly the returned mutants run and their number never exceeds the budget.
 * Deterministic: candidates are taken in file/position order; a range is added only if every mutant it would
 * include still fits in the budget. Exported for tests.
 */
export function planMutants(
  candidates: PlannedMutant[],
  targets: MutationRunArgs["targets"],
  maxMutants: number,
): { mutate: string[]; selected: PlannedMutant[]; sampled: boolean } {
  const sorted = [...candidates].sort(compareMutants);
  if (sorted.length <= maxMutants) {
    return {
      mutate: targets.flatMap((t) => t.ranges.map((r) => `${t.file}:${r.start}-${r.end}`)),
      selected: sorted,
      sampled: false,
    };
  }
  const selected = new Set<PlannedMutant>();
  const mutate: string[] = [];
  for (const candidate of sorted) {
    if (selected.has(candidate)) continue;
    const range = { start: candidate.start, end: candidate.end };
    const included = sorted.filter((m) => m.file === candidate.file && contains(range, m));
    const additions = included.filter((m) => !selected.has(m));
    if (selected.size + additions.length > maxMutants) continue;
    for (const m of additions) selected.add(m);
    mutate.push(`${candidate.file}:${range.start.line + 1}:${range.start.column}-${range.end.line + 1}:${range.end.column}`);
    if (selected.size === maxMutants) break;
  }
  return { mutate, selected: sorted.filter((m) => selected.has(m)), sampled: true };
}

const STATUS: Record<string, MutantResult["status"]> = {
  Killed: "killed",
  Survived: "survived",
  NoCoverage: "no-coverage",
  Timeout: "timeout",
  CompileError: "invalid",
  RuntimeError: "invalid",
  Ignored: "ignored",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    if ((await stat(path)).size > maxBytes) throw new MutationError("Stryker report is too large");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof MutationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MutationError(`Stryker report could not be read: ${(error as Error).message}`);
  }
}

/**
 * Validated combinations. Outside them Stryker can silently fail to activate mutants — for example
 * @stryker-mutator/vitest-runner 10.0.0 with Vitest 5 reports every mutant as survived — so running would
 * produce meaningless findings. Unvalidated combinations are an ERROR, never a PASS or a WARN.
 */
export const SUPPORTED_VERSIONS = {
  strykerCore: { min: 10, max: 10 },
  jest: { min: 27, max: 30 },
  vitest: { min: 2, max: 4 },
} as const;

function major(version: string | undefined): number | undefined {
  const match = /^(\d+)\./.exec(version ?? "");
  return match ? Number(match[1]) : undefined;
}

export function checkCompatibility(coreVersion: string, framework: "jest" | "vitest", frameworkVersion: string | undefined): string | undefined {
  const coreMajor = major(coreVersion);
  const { strykerCore } = SUPPORTED_VERSIONS;
  if (coreMajor === undefined || coreMajor < strykerCore.min || coreMajor > strykerCore.max) {
    return `@stryker-mutator/core ${coreVersion} is not a validated version (supported: ${strykerCore.min}.x); set mutation.enabled: false or use a supported version`;
  }
  const range = SUPPORTED_VERSIONS[framework];
  const fwMajor = major(frameworkVersion);
  if (fwMajor === undefined || fwMajor < range.min || fwMajor > range.max) {
    return `${framework} ${frameworkVersion ?? "(not installed)"} is not validated with Stryker mutation testing (supported: ${framework} ${range.min}.x–${range.max}.x); set mutation.enabled: false or use a supported version`;
  }
  return undefined;
}

export class StrykerAdapter implements MutationAdapter {
  async run(args: MutationRunArgs): Promise<MutationRunResult> {
    const deadline = Date.now() + args.timeoutMs;
    const remaining = () => deadline - Date.now();
    for (const target of args.targets) {
      if (GLOB_SPECIAL.test(target.file)) {
        throw new MutationError(`cannot target ${JSON.stringify(target.file)} precisely: Stryker treats glob characters in paths as patterns`);
      }
    }

    const core = await findInstalledPackage("@stryker-mutator/core", args.projectDir, args.root, "stryker");
    const runnerName = `@stryker-mutator/${args.framework}-runner`;
    const runner = await findInstalledPackage(runnerName, args.projectDir, args.root);
    if (!core?.bin || !runner) {
      throw new MutationError(
        `mutation testing requires @stryker-mutator/core and ${runnerName} in the project's devDependencies (or set mutation.enabled: false)`,
      );
    }
    const frameworkPackage = await findInstalledPackage(args.framework, args.projectDir, args.root);
    const compatibility = checkCompatibility(core.version, args.framework, frameworkPackage?.version);
    if (compatibility) throw new MutationError(compatibility);

    const env = { ...args.env };
    env.NO_COLOR = "1";
    env.FORCE_COLOR = "0";
    const id = randomUUID();

    // 1. Enumerate candidate mutants in a sanitised child process.
    const files = [];
    for (const target of args.targets) {
      const absolute = resolve(args.projectDir, ...target.file.split("/"));
      files.push({
        name: absolute,
        content: await readFile(absolute, "utf8"),
        ranges: target.ranges.map((r) => ({ start: { line: r.start - 1, column: 0 }, end: { line: r.end - 1, column: MAX_SAFE } })),
      });
    }
    const scriptPath = join(args.scratchDir, `enumerate-${id}.mjs`);
    const inputPath = join(args.scratchDir, `enumerate-${id}.json`);
    await writeFile(scriptPath, ENUMERATOR_SCRIPT);
    await writeFile(inputPath, JSON.stringify({ projectDir: args.projectDir, files }));
    if (remaining() <= 0) throw new MutationError("mutation testing exceeded its time budget");
    const enumeration = await runProcess({
      command: args.node,
      args: [scriptPath, inputPath],
      cwd: args.projectDir,
      env,
      timeoutMs: remaining(),
      maxOutputBytes: 32 * 1024 * 1024,
    });
    await rm(inputPath, { force: true });
    if (enumeration.timedOut) throw new MutationError("mutation testing exceeded its time budget while enumerating mutants");
    if (enumeration.exitCode !== 0 || enumeration.outputTruncated) {
      throw new MutationError(`could not enumerate mutants: ${enumeration.spawnError ?? enumeration.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(enumeration.stdout);
    } catch {
      throw new MutationError("mutant enumeration produced malformed output");
    }
    if (!Array.isArray(raw)) throw new MutationError("mutant enumeration produced malformed output");

    const candidates: PlannedMutant[] = [];
    const absToRel = new Map(files.map((f, i) => [f.name, args.targets[i]?.file as string]));
    for (const m of raw) {
      if (!isRecord(m) || !isRecord(m.location) || !isRecord(m.location.start) || !isRecord(m.location.end)) {
        throw new MutationError("mutant enumeration produced malformed output");
      }
      if (m.status === "Ignored") continue;
      const file = absToRel.get(String(m.fileName));
      if (file === undefined) throw new MutationError("mutant enumeration reported an unexpected file");
      candidates.push({
        file,
        mutatorName: String(m.mutatorName),
        replacement: String(m.replacement),
        start: { line: Number(m.location.start.line), column: Number(m.location.start.column) },
        end: { line: Number(m.location.end.line), column: Number(m.location.end.column) },
      });
    }
    if (candidates.length === 0) return { candidates: 0, sampled: false, mutants: [] };

    const plan = planMutants(candidates, args.targets, args.maxMutants);
    if (plan.selected.length === 0) {
      throw new MutationError(`no mutant group fits within maxMutants=${args.maxMutants}`);
    }

    // 2. Run Stryker in place inside the disposable head worktree.
    const reportPath = join(args.scratchDir, `stryker-${id}.json`);
    const configPath = join(args.scratchDir, `stryker-${id}.conf.json`);
    const config = {
      testRunner: args.framework,
      mutate: plan.mutate,
      reporters: ["json"],
      jsonReporter: { fileName: reportPath },
      inPlace: true,
      incremental: false,
      coverageAnalysis: "perTest",
      concurrency: Math.max(1, Math.min(4, cpus().length - 1)),
      fileLogLevel: "off",
      logLevel: "warn",
      allowConsoleColors: false,
      cleanTempDir: "always",
      disableTypeChecks: true,
      checkers: [],
      ignorers: [],
      thresholds: { high: 80, low: 60, break: null },
      ...(args.framework === "jest" ? { jest: { projectType: "custom", enableFindRelatedTests: true } } : { vitest: { related: true } }),
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    if (remaining() <= 0) throw new MutationError("mutation testing exceeded its time budget");
    const run = await runProcess({
      command: args.node,
      args: [core.bin, "run", configPath],
      cwd: args.projectDir,
      env,
      timeoutMs: remaining(),
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (run.timedOut) throw new MutationError("mutation testing exceeded its time budget");
    if (run.exitCode !== 0) {
      const detail = run.spawnError ?? [run.stderr, run.stdout].join("\n").trim().split("\n").filter(Boolean).slice(-4).join(" ");
      throw new MutationError(`Stryker failed (exit code ${run.exitCode ?? run.signal ?? "unknown"}): ${detail}`);
    }

    // 3. Validate the report against the plan.
    const report = await readJson(reportPath, 64 * 1024 * 1024);
    await rm(reportPath, { force: true });
    if (!isRecord(report) || !isRecord(report.files)) throw new MutationError("Stryker did not produce a valid mutation report");
    const planned = new Map(plan.selected.map((m) => [key(m.file, m.mutatorName, m.replacement, m.start, m.end), m]));
    const mutants: MutantResult[] = [];
    const seen = new Set<string>();
    for (const [reportFile, entry] of Object.entries(report.files)) {
      const file = reportFile.replace(/\\/g, "/");
      if (!isRecord(entry) || !Array.isArray(entry.mutants)) throw new MutationError("Stryker report is malformed");
      for (const m of entry.mutants) {
        if (!isRecord(m) || !isRecord(m.location) || !isRecord(m.location.start) || !isRecord(m.location.end)) {
          throw new MutationError("Stryker report is malformed");
        }
        const start = { line: Number(m.location.start.line) - 1, column: Number(m.location.start.column) - 1 };
        const end = { line: Number(m.location.end.line) - 1, column: Number(m.location.end.column) - 1 };
        const k = key(file, String(m.mutatorName), String(m.replacement), start, end);
        const status = STATUS[String(m.status)];
        if (status === undefined) throw new MutationError(`Stryker reported an incomplete mutant status: ${String(m.status)}`);
        if (status === "ignored") continue;
        if (!planned.has(k) || seen.has(k)) throw new MutationError("Stryker ran mutants outside the planned set; the budget cannot be guaranteed");
        seen.add(k);
        mutants.push({
          file,
          line: start.line + 1,
          column: start.column + 1,
          mutator: String(m.mutatorName),
          replacement: String(m.replacement),
          status,
        });
      }
    }
    if (seen.size !== planned.size) {
      throw new MutationError(`Stryker reported ${seen.size} of ${planned.size} planned mutants`);
    }
    return { candidates: candidates.length, sampled: plan.sampled, mutants };
  }
}
