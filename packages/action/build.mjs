// Bundles the GitHub Action into a single CommonJS file for the Node 24 Actions runtime.
// Only Merge Integrity's own code and its small runtime dependencies are bundled; the scanned project's
// Jest/Vitest/Stryker are always resolved from the project at run time.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/index.cjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  logLevel: "warning",
  absWorkingDir: root,
  alias: {
    "@merge-integrity/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
  },
});
console.log("bundled packages/action/dist/index.cjs");
