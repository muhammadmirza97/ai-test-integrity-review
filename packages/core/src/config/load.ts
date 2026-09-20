import type { MergeIntegrityConfig } from "../domain/config.js";
import { readBlob } from "../git/repository.js";
import { MAX_CONFIG_BYTES, parseConfigText } from "./parse.js";

export type CommitConfig =
  | { kind: "missing" }
  | { kind: "valid"; config: MergeIntegrityConfig }
  | { kind: "invalid"; errors: string[] };

/** Load `.merge-integrity.yml` from a commit (never from the working tree). */
export async function loadConfigFromCommit(repoRoot: string, commit: string, path: string, label: string): Promise<CommitConfig> {
  let blob;
  try {
    blob = await readBlob(repoRoot, commit, path, MAX_CONFIG_BYTES);
  } catch (error) {
    return { kind: "invalid", errors: [`${label}:${path}: ${(error as Error).message}`] };
  }
  if (blob.kind === "missing") return { kind: "missing" };
  if (blob.kind === "not-a-file") return { kind: "invalid", errors: [`${label}:${path}: is not a regular file (mode ${blob.mode})`] };
  const parsed = parseConfigText(blob.text, `${label}:${path}`);
  return parsed.ok ? { kind: "valid", config: parsed.config } : { kind: "invalid", errors: parsed.errors };
}
