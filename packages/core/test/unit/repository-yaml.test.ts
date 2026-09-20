import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../test-support/repo.js";

/**
 * The GitHub issue forms and the example workflows are shipped to users and are only ever parsed by GitHub.
 * A YAML mistake in them is invisible until someone tries to open an issue or copy a workflow, so they are
 * parsed here. (A value containing ": " must be quoted — that mistake shipped once.)
 */

const ISSUE_TEMPLATES = join(REPO_ROOT, ".github", "ISSUE_TEMPLATE");

describe("shipped YAML is valid", () => {
  const templates = readdirSync(ISSUE_TEMPLATES).filter((name) => name.endsWith(".yml"));

  it("has an issue form for every alpha feedback category, plus the contact links", () => {
    expect(templates.sort()).toEqual(["alpha-feedback.yml", "compatibility.yml", "config.yml", "false-finding.yml", "useful-finding.yml"]);
  });

  it.each(templates)("%s parses and has the fields GitHub requires", (name) => {
    const doc = parse(readFileSync(join(ISSUE_TEMPLATES, name), "utf8")) as Record<string, unknown>;
    expect(doc, name).toBeTypeOf("object");
    if (name === "config.yml") {
      expect(Array.isArray(doc.contact_links)).toBe(true);
      return;
    }
    expect(typeof doc.name).toBe("string");
    expect(typeof doc.description).toBe("string");
    const body = doc.body as { type?: string; attributes?: Record<string, unknown> }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const field of body) {
      expect(["markdown", "input", "textarea", "dropdown", "checkboxes"], `${name}: ${String(field.type)}`).toContain(field.type);
    }
  });

  it("every form warns against pasting secrets or private code", () => {
    for (const name of templates.filter((t) => t !== "config.yml")) {
      const text = readFileSync(join(ISSUE_TEMPLATES, name), "utf8");
      expect(text, name).toMatch(/secrets, tokens, credentials, private source code, or proprietary logs/i);
    }
  });

  it.each(["examples/github-workflow.yml", "examples/github-workflow-preflight.yml", "examples/.merge-integrity.yml", "action.yml"])(
    "%s parses",
    (relative) => {
      expect(parse(readFileSync(join(REPO_ROOT, ...relative.split("/")), "utf8"))).toBeTypeOf("object");
    },
  );

  it("the example workflows never use pull_request_target", () => {
    for (const relative of ["examples/github-workflow.yml", "examples/github-workflow-preflight.yml"]) {
      expect(readFileSync(join(REPO_ROOT, ...relative.split("/")), "utf8")).not.toMatch(/^\s*pull_request_target\s*:/m);
    }
  });

  it("the example policy file matches the calibrated defaults (no rule is stricter by accident)", () => {
    const policy = parse(readFileSync(join(REPO_ROOT, "examples", ".merge-integrity.yml"), "utf8")) as Record<string, unknown>;
    expect(policy.rules).toEqual({});
    expect(policy.ignore).toEqual([]);
    expect((policy.mutation as { enabled: boolean }).enabled).toBe(false);
  });
});
