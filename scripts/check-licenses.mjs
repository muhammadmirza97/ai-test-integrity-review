// Verifies the licences of every third-party package that ends up inside the shipped Action bundle.
// Fails when a bundled package has a licence outside the permissive allowlist.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

const result = await build({
  entryPoints: [join(root, "packages/action/src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  write: false,
  metafile: true,
  logLevel: "silent",
  absWorkingDir: root,
  alias: { "@merge-integrity/core": join(root, "packages/core/src/index.ts") },
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const normalized = input.split("/").join(sep);
  const index = normalized.lastIndexOf(`node_modules${sep}`);
  if (index === -1) continue;
  const rest = normalized.slice(index + "node_modules".length + 1).split(sep);
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const manifestPath = join(root, normalized.slice(0, index), "node_modules", ...name.split("/"), "package.json");
  if (packages.has(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  packages.set(manifestPath, { name: manifest.name, version: manifest.version, license: manifest.license });
}

let failed = false;
const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const pkg of rows) {
  const ok = typeof pkg.license === "string" && ALLOWED.has(pkg.license);
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${pkg.name}@${pkg.version} ${pkg.license ?? "(no licence field)"}`);
}
console.log(`${rows.length} bundled third-party package(s) checked against: ${[...ALLOWED].join(", ")}`);
if (failed) {
  console.error("Licence check failed.");
  process.exit(1);
}
