import { parseDocument } from "yaml";
import type { RawFinding } from "../domain/finding.js";

/**
 * Structural comparison of GitHub workflow files that run Merge Integrity.
 *
 * Under `pull_request`, GitHub executes the workflow definition from the pull request itself, so a PR can edit the
 * gate that judges it. This rule reports, from parsed YAML (not text matching):
 * - MI005 (BLOCK): the gate step disappeared (removed, commented out, workflow deleted);
 * - MI106 (BLOCK): the gate can be skipped or weakened (inputs, `if`, `continue-on-error`, triggers/filters,
 *   a different Action repository, a changed CLI command, or an unparsable workflow);
 * - MI101 (WARN): only the pinned version of the same Action changed.
 * It cannot stop a PR from replacing the workflow; see SECURITY.md for the required repository protection.
 */

interface Gate {
  jobId: string;
  kind: "action" | "cli";
  repository?: string;
  ref?: string;
  run?: string;
  with: Record<string, string>;
  stepIf?: string;
  jobIf?: string;
  stepContinue: boolean;
  jobContinue: boolean;
}

interface WorkflowModel {
  gates: Gate[];
  triggers: Map<string, string>;
}

// The Action repository was published as "ai-test-integrity-review"; the CLI, the config file and the check
// output are still named `merge-integrity`. Both names must identify a gate step, or a workflow that runs the
// published Action would not be checked at all (MI005/MI106 would silently stop applying).
const GATE_ACTION = /(merge|test)-integrity/i;
const GATE_CLI = /(merge|test)-integrity[^\n]*\bcheck\b|packages\/cli\/dist\/main\.js[^\n]*\bcheck\b/;
const SENSITIVE_INPUTS = ["mode", "base-ref", "head-ref", "config-source", "red-green", "mutation", "working-directory", "config", "framework"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return JSON.stringify(value);
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  const text = scalar(value).toLowerCase();
  return text !== "" && text !== "false";
}

class WorkflowParseError extends Error {}

function parseWorkflow(text: string): WorkflowModel {
  const doc = parseDocument(text, { uniqueKeys: false, prettyErrors: false });
  if (doc.errors.length > 0) throw new WorkflowParseError(doc.errors[0]?.message ?? "invalid YAML");
  const root: unknown = doc.toJS({ maxAliasCount: 100 });
  if (!isRecord(root)) throw new WorkflowParseError("workflow is not a mapping");

  const triggers = new Map<string, string>();
  const on = root.on ?? root.true; // YAML 1.1 parsers may read `on` as boolean true
  if (typeof on === "string") triggers.set(on, "");
  else if (Array.isArray(on)) for (const e of on) triggers.set(scalar(e), "");
  else if (isRecord(on)) for (const [event, filters] of Object.entries(on)) triggers.set(event, filters === null || filters === undefined ? "" : JSON.stringify(filters));

  const gates: Gate[] = [];
  if (isRecord(root.jobs)) {
    for (const [jobId, job] of Object.entries(root.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (!isRecord(step)) continue;
        const uses = typeof step.uses === "string" ? step.uses.trim() : undefined;
        const run = typeof step.run === "string" ? step.run : undefined;
        let gate: Gate | undefined;
        const common = {
          jobId,
          with: Object.fromEntries(Object.entries(isRecord(step.with) ? step.with : {}).map(([k, v]) => [k, scalar(v)])),
          ...(step.if === undefined ? {} : { stepIf: scalar(step.if) }),
          ...(job.if === undefined ? {} : { jobIf: scalar(job.if) }),
          stepContinue: truthy(step["continue-on-error"]),
          jobContinue: truthy(job["continue-on-error"]),
        };
        if (uses !== undefined && GATE_ACTION.test(uses.split("@")[0] ?? "") && common.with.mode?.toLowerCase() !== "doctor") {
          // A `mode: doctor` step is the compatibility preflight: it makes no merge decision, so it is not a
          // gate. Adding or removing a preflight workflow must not be reported as removing the gate.
          const [repository, ref] = uses.split("@");
          gate = { ...common, kind: "action", repository: (repository ?? "").toLowerCase(), ...(ref === undefined ? {} : { ref }) };
        } else if (run !== undefined && GATE_CLI.test(run)) {
          gate = { ...common, kind: "cli", run: run.trim() };
        }
        if (gate) gates.push(gate);
      }
    }
  }
  return { gates, triggers };
}

export function compareWorkflow(file: string, baseText: string | undefined, headText: string | undefined): RawFinding[] {
  if (baseText === undefined) return [];
  let base: WorkflowModel;
  try {
    base = parseWorkflow(baseText);
  } catch {
    return []; // the base workflow could not have run the gate reliably either
  }
  if (base.gates.length === 0) return [];

  if (headText === undefined) {
    return [{ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: "A workflow that ran Merge Integrity was deleted." }];
  }
  let head: WorkflowModel;
  try {
    head = parseWorkflow(headText);
  } catch (error) {
    return [
      {
        ruleId: "MI106_POLICY_WEAKENED",
        file,
        message: `A workflow that runs Merge Integrity can no longer be parsed (${(error as Error).message}); the gate cannot be confirmed intact.`,
      },
    ];
  }
  if (head.gates.length === 0) {
    return [{ ruleId: "MI005_TEST_COMMAND_BYPASS", file, message: "This workflow no longer runs Merge Integrity." }];
  }

  const findings: RawFinding[] = [];
  const reasons: string[] = [];
  for (const [event, filters] of base.triggers) {
    if (event !== "pull_request" && event !== "merge_group") continue;
    if (!head.triggers.has(event)) reasons.push(`the ${event} trigger was removed`);
    else if (head.triggers.get(event) !== filters) reasons.push(`the ${event} trigger filters changed`);
  }

  for (const baseGate of base.gates) {
    const headGate =
      head.gates.find((g) => g.jobId === baseGate.jobId && g.kind === baseGate.kind) ??
      head.gates.find((g) => g.kind === baseGate.kind) ??
      (head.gates[0] as Gate);
    if (baseGate.kind === "action" && headGate.kind === "action") {
      if (headGate.repository !== baseGate.repository) {
        reasons.push(`the Merge Integrity Action was replaced by ${JSON.stringify(headGate.repository)}`);
      } else if (headGate.ref !== baseGate.ref) {
        findings.push({
          ruleId: "MI101_ASSERTION_CHANGE_AMBIGUOUS",
          file,
          message: `The pinned Merge Integrity Action version changed from ${JSON.stringify(baseGate.ref ?? "")} to ${JSON.stringify(headGate.ref ?? "")}; confirm the new version is trusted.`,
        });
      }
      for (const key of SENSITIVE_INPUTS) {
        const before = baseGate.with[key] ?? "";
        const after = headGate.with[key] ?? "";
        if (before === after) continue;
        const strengthening = (key === "mutation" && after === "true") || (key === "config-source" && after === "base" && before === "");
        if (!strengthening) reasons.push(`the "${key}" input changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
      }
    } else if (baseGate.kind !== headGate.kind || baseGate.run !== headGate.run) {
      reasons.push("the command or Action that runs Merge Integrity changed");
    }
    if ((headGate.stepIf ?? "") !== (baseGate.stepIf ?? "")) reasons.push("the gate step's `if` condition changed");
    if ((headGate.jobIf ?? "") !== (baseGate.jobIf ?? "")) reasons.push("the gate job's `if` condition changed");
    if (headGate.stepContinue && !baseGate.stepContinue) reasons.push("the gate step now has continue-on-error");
    if (headGate.jobContinue && !baseGate.jobContinue) reasons.push("the gate job now has continue-on-error");
  }

  if (reasons.length > 0) {
    findings.push({
      ruleId: "MI106_POLICY_WEAKENED",
      file,
      message: `The pull request changes how Merge Integrity runs so it could be skipped or weakened: ${[...new Set(reasons)].join("; ")}.`,
      evidence: { reasons: [...new Set(reasons)] },
    });
  }
  return findings;
}
