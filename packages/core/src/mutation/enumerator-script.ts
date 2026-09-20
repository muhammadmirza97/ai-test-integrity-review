/**
 * Source of a small Node script that enumerates the mutants Stryker would generate for given line ranges.
 *
 * It imports the project's own @stryker-mutator/instrumenter, so it runs in a child process with a sanitised
 * environment (repository-installed code must never run inside the Merge Integrity process itself).
 * Input: argv[2] = path of a JSON file { projectDir, files: [{ name, content, ranges }] }.
 * Output: JSON array of mutants on stdout.
 */
export const ENUMERATOR_SCRIPT = `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const projectRequire = createRequire(join(input.projectDir, "package.json"));
const corePackage = projectRequire.resolve("@stryker-mutator/core/package.json");
const coreRequire = createRequire(corePackage);
const instrumenterEntry = coreRequire.resolve("@stryker-mutator/instrumenter");
const { Instrumenter } = await import(pathToFileURL(instrumenterEntry).href);
const noop = () => {};
const logger = {
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
  isTraceEnabled: () => false, isDebugEnabled: () => false, isInfoEnabled: () => false,
  isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false,
};
const instrumenter = new Instrumenter(logger);
const result = await instrumenter.instrument(
  input.files.map((f) => ({ name: f.name, content: f.content, mutate: f.ranges })),
  { plugins: null, excludedMutations: [], ignorers: [] },
);
process.stdout.write(JSON.stringify(result.mutants.map((m) => ({
  fileName: m.fileName,
  mutatorName: m.mutatorName,
  replacement: m.replacement,
  location: m.location,
  status: m.status ?? null,
}))));
`;
