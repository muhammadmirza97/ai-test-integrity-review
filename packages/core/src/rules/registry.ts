import { posix } from "node:path";
import { analyzeTestSource, type TestBlock } from "../ast/tests.js";
import { MAX_PARSE_BYTES } from "../ast/parse.js";
import type { MergeIntegrityConfig } from "../domain/config.js";
import { RULES, type Finding, type RawFinding } from "../domain/finding.js";
import { classifyPath, isImplementationClass, type FileClass } from "../git/classify.js";
import { readBlob, type ChangedFile } from "../git/repository.js";
import { compareTestFile, type ChangedTest } from "./test-integrity.js";
import { comparePackageManifest, compareTestConfig } from "./test-command-bypass.js";
import { compareWorkflow } from "./workflow-integrity.js";

export class AnalysisInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisInputError";
  }
}

export interface ProjectChange extends ChangedFile {
  /** Path relative to the working directory. */
  relPath: string;
  relOldPath?: string;
  fileClass: FileClass;
}

export interface DeterministicResult {
  rawFindings: RawFinding[];
  projectChanges: ProjectChange[];
  /** Changed or added test files (repository-relative head paths) that contain changed runnable tests. */
  changedTestFiles: string[];
  /** Changed or added runnable test cases per changed test file (repository-relative head path). */
  changedTests: Map<string, ChangedTest[]>;
  implementationChanged: boolean;
  dependencyManifestChanged: boolean;
}

export interface DeterministicInput {
  repoRoot: string;
  mergeBase: string;
  head: string;
  workingDirectory: string;
  changes: ChangedFile[];
  /** Project-relative test-file predicate from test discovery (defaults to naming conventions). */
  isTestFile?: (relPath: string) => boolean;
}

function toProjectPath(path: string, workingDirectory: string): string | undefined {
  if (workingDirectory === ".") return path;
  const prefix = `${workingDirectory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

async function readText(repoRoot: string, commit: string, path: string): Promise<string | undefined> {
  const blob = await readBlob(repoRoot, commit, path, MAX_PARSE_BYTES);
  if (blob.kind === "missing") return undefined;
  if (blob.kind === "not-a-file") {
    throw new AnalysisInputError("UNSUPPORTED_FILE", `${path} is not a regular file (mode ${blob.mode}); it cannot be analysed safely`);
  }
  return blob.text;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Repository tooling files (dot-files and dot-directories such as .github/, .eslintrc, .gitignore) do not change behaviour under test. */
function isTooling(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment.startsWith(".")) || posix.basename(relPath) === "CODEOWNERS";
}

/** Run the deterministic rules (MI001–MI005, MI101, MI104, MI105, workflow part of MI106) over a diff. */
export async function runDeterministicRules(input: DeterministicInput): Promise<DeterministicResult> {
  const { repoRoot, mergeBase, head, workingDirectory } = input;
  const rawFindings: RawFinding[] = [];
  const projectChanges: ProjectChange[] = [];
  const changedTestFiles: string[] = [];
  const changedTests = new Map<string, ChangedTest[]>();
  const removed: { file: string; block: TestBlock }[] = [];
  const added: TestBlock[] = [];

  for (const change of input.changes) {
    if (WORKFLOW.test(change.path) || (change.oldPath !== undefined && WORKFLOW.test(change.oldPath))) {
      const baseText = change.status === "added" ? undefined : await readText(repoRoot, mergeBase, change.oldPath ?? change.path);
      const headText = change.status === "deleted" ? undefined : await readText(repoRoot, head, change.path);
      rawFindings.push(...compareWorkflow(change.path, baseText, headText));
    }

    const relPath = toProjectPath(change.path, workingDirectory);
    const relOldPath = change.oldPath === undefined ? undefined : toProjectPath(change.oldPath, workingDirectory);
    if (relPath === undefined && relOldPath === undefined) continue;
    const projectPath = relPath ?? (relOldPath as string);
    const fileClass = input.isTestFile?.(projectPath) ? "test" : classifyPath(projectPath);
    projectChanges.push({ ...change, relPath: relPath ?? (relOldPath as string), ...(relOldPath ? { relOldPath } : {}), fileClass });

    const basePath = change.oldPath ?? change.path;
    const baseInProject = (change.oldPath === undefined ? relPath : relOldPath) !== undefined;
    const headInProject = relPath !== undefined;

    if (fileClass === "test") {
      const baseText = change.status === "added" || !baseInProject ? undefined : await readText(repoRoot, mergeBase, basePath);
      const headText = change.status === "deleted" || !headInProject ? undefined : await readText(repoRoot, head, change.path);
      const baseModel = baseText === undefined ? undefined : analyzeTestSource(baseText, basePath);
      const headModel = headText === undefined ? undefined : analyzeTestSource(headText, change.path);
      const comparison = compareTestFile(change.path, baseModel, headModel);
      rawFindings.push(...comparison.findings);

      if (headModel === undefined && baseModel !== undefined) {
        const runnable = baseModel.blocks.filter((b) => b.kind === "test" && b.hasCallback && !b.todo && b.skip !== "unconditional");
        if (runnable.length > 0) {
          rawFindings.push({
            ruleId: "MI104_TEST_DELETED",
            file: basePath,
            message: `Test file deleted with ${runnable.length} test(s).`,
            evidence: { tests: runnable.slice(0, 20).map((b) => [...b.path, b.name].join(" > ")) },
          });
        }
        continue;
      }
      removed.push(...comparison.removedTests.map((block) => ({ file: change.path, block })));
      added.push(...comparison.addedTests);
      if (headModel !== undefined && comparison.changedTests.length > 0) {
        changedTestFiles.push(change.path);
        changedTests.set(change.path, comparison.changedTests);
      }
    } else if (fileClass === "test-config" && relPath !== undefined && !relPath.includes("/")) {
      const baseText = change.status === "added" ? undefined : await readText(repoRoot, mergeBase, basePath);
      const headText = change.status === "deleted" ? undefined : await readText(repoRoot, head, change.path);
      rawFindings.push(...compareTestConfig(change.path, baseText, headText));
    } else if (fileClass === "package-manifest") {
      const baseText = change.status === "added" ? undefined : await readText(repoRoot, mergeBase, basePath);
      const headText = change.status === "deleted" ? undefined : await readText(repoRoot, head, change.path);
      if (baseText !== undefined && headText === undefined) {
        rawFindings.push({ ruleId: "MI005_TEST_COMMAND_BYPASS", file: change.path, message: "package.json was deleted." });
      } else {
        rawFindings.push(...comparePackageManifest(change.path, baseText, headText));
      }
    }
  }

  // Tests moved between files unchanged are not deletions.
  const addedSignatures = new Set(added.map((b) => `${b.name}\0${b.bodySignature}`));
  for (const { file, block } of removed) {
    if (addedSignatures.has(`${block.name}\0${block.bodySignature}`)) continue;
    rawFindings.push({
      ruleId: "MI104_TEST_DELETED",
      file,
      message: `Test ${[...block.path, block.name].map((n) => JSON.stringify(n)).join(" > ")} was deleted.`,
      evidence: { baseLine: block.line },
    });
  }

  return {
    rawFindings,
    projectChanges,
    changedTestFiles,
    changedTests,
    implementationChanged: projectChanges.some((c) => isImplementationClass(c.fileClass) && !isTooling(c.relPath)),
    dependencyManifestChanged: projectChanges.some((c) => c.fileClass === "package-manifest" || c.fileClass === "lockfile"),
  };
}

/** Apply configured severities and rule titles. */
export function toFindings(raw: readonly RawFinding[], config: MergeIntegrityConfig): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const finding of raw) {
    const key = JSON.stringify([finding.ruleId, finding.file, finding.startLine, finding.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...finding, severity: config.rules[finding.ruleId], title: RULES[finding.ruleId].title });
  }
  return findings;
}
