import { readFileSync, statSync } from "node:fs";

export type ActionMode = "check" | "doctor";

export interface ActionInputs {
  /** `doctor` runs the compatibility preflight instead of analysing a pull request. Never used for enforcement. */
  mode: ActionMode;
  workingDirectory: string | undefined;
  config: string | undefined;
  configSource: "base" | "head" | undefined;
  framework: "auto" | "jest" | "vitest" | undefined;
  /** undefined = use the policy. */
  mutation: boolean | undefined;
  /** undefined = use the policy. */
  redGreen: boolean | undefined;
  baseRef: string | undefined;
  headRef: string | undefined;
}

export class InputError extends Error {}

/** Events whose result is used as a merge decision. Inputs come from the PR's own workflow file there. */
export const PROTECTED_EVENTS = new Set(["pull_request", "merge_group"]);

/** Read an action input the way the runner exposes it (INPUT_<NAME> with spaces replaced by underscores). */
export function getInput(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function booleanInput(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = getInput(env, name);
  if (raw === "") return undefined;
  if (["true", "True", "TRUE"].includes(raw)) return true;
  if (["false", "False", "FALSE"].includes(raw)) return false;
  throw new InputError(`input "${name}" must be true or false`);
}

export function parseInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const mode = getInput(env, "mode") || "check";
  if (mode !== "check" && mode !== "doctor") {
    throw new InputError('input "mode" must be check or doctor');
  }
  const configSource = getInput(env, "config-source") || undefined;
  if (configSource !== undefined && configSource !== "base" && configSource !== "head") {
    throw new InputError('input "config-source" must be base or head');
  }
  const framework = getInput(env, "framework") || undefined;
  if (framework !== undefined && framework !== "auto" && framework !== "jest" && framework !== "vitest") {
    throw new InputError('input "framework" must be auto, jest or vitest');
  }
  return {
    mode,
    workingDirectory: getInput(env, "working-directory") || undefined,
    config: getInput(env, "config") || undefined,
    configSource,
    framework,
    mutation: booleanInput(env, "mutation"),
    redGreen: booleanInput(env, "red-green"),
    baseRef: getInput(env, "base-ref") || undefined,
    headRef: getInput(env, "head-ref") || undefined,
  };
}

/**
 * In pull_request/merge_group runs the workflow file (and therefore every input) is controlled by the pull request
 * under review. Inputs may not change what is compared or weaken the base-branch policy; only enabling mutation
 * testing (a stricter check) is accepted. Anything else is an ERROR, never a silently weaker PASS.
 */
export function enforceProtectedInputs(event: string, inputs: ActionInputs): void {
  if (!PROTECTED_EVENTS.has(event)) return;
  const violations: string[] = [];
  // `mode: doctor` never analyses the pull request, so on a protected event it would turn the gate into a no-op.
  if (inputs.mode !== "check") violations.push("mode (must be check)");
  if (inputs.baseRef !== undefined) violations.push("base-ref");
  if (inputs.headRef !== undefined) violations.push("head-ref");
  if (inputs.configSource !== undefined && inputs.configSource !== "base") violations.push("config-source (must be base)");
  if (inputs.redGreen === false) violations.push("red-green: false");
  if (inputs.mutation === false) violations.push("mutation: false");
  if (inputs.workingDirectory !== undefined && inputs.workingDirectory !== ".") violations.push("working-directory");
  if (inputs.config !== undefined && inputs.config !== ".merge-integrity.yml") violations.push("config");
  if (inputs.framework !== undefined && inputs.framework !== "auto") violations.push("framework");
  if (violations.length > 0) {
    throw new InputError(
      `inputs are not permitted on ${event} runs because the pull request controls them: ${violations.join(", ")}. ` +
        "Configure these settings in .merge-integrity.yml on the base branch; refs are always taken from the event.",
    );
  }
}

export interface ResolvedRefs {
  event: string;
  baseRef: string;
  headRef: string;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function readEvent(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new InputError("GITHUB_EVENT_PATH is not set");
  if (statSync(path).size > 25 * 1024 * 1024) throw new InputError("the event payload is too large");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) throw new InputError("the event payload is not an object");
  return value as Record<string, unknown>;
}

function sha(value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new InputError(`${what} is missing from the event payload`);
  return value;
}

/**
 * Determine base and head commits. `pull_request_target` is refused (privileged token with untrusted code).
 * For `pull_request` and `merge_group`, refs come only from trusted event metadata.
 */
export function resolveRefs(env: NodeJS.ProcessEnv, inputs: ActionInputs): ResolvedRefs {
  const event = env.GITHUB_EVENT_NAME ?? "";
  if (event === "pull_request_target") {
    throw new InputError(
      "refusing to run on pull_request_target: it executes untrusted pull request code with a privileged token. Use `on: pull_request`.",
    );
  }
  enforceProtectedInputs(event, inputs);
  if (event === "pull_request") {
    const payload = readEvent(env);
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const base = sha((pr?.base as Record<string, unknown> | undefined)?.sha, "pull_request.base.sha");
    const head = sha(env.GITHUB_SHA, "GITHUB_SHA");
    if (base === head) throw new InputError("the event's base and head commits are identical; nothing can be verified");
    return { event, baseRef: base, headRef: head };
  }
  if (event === "merge_group") {
    const payload = readEvent(env);
    const group = payload.merge_group as Record<string, unknown> | undefined;
    const base = sha(group?.base_sha, "merge_group.base_sha");
    const head = sha(group?.head_sha, "merge_group.head_sha");
    if (base === head) throw new InputError("the event's base and head commits are identical; nothing can be verified");
    return { event, baseRef: base, headRef: head };
  }
  if (inputs.baseRef !== undefined) {
    return { event, baseRef: inputs.baseRef, headRef: inputs.headRef ?? env.GITHUB_SHA ?? "HEAD" };
  }
  throw new InputError(`unsupported event "${event}": use pull_request or merge_group, or provide the base-ref input`);
}
