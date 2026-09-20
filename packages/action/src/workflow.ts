import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

/**
 * Minimal, dependency-free implementation of the GitHub Actions workflow-command and file-command protocols.
 * All repository-derived text passes through the escaping functions below before reaching the runner.
 */

/** Escape a workflow-command message (data part). */
export function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow-command property value (file, title, ...). */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export interface Annotation {
  level: "error" | "warning" | "notice";
  message: string;
  title?: string;
  file?: string;
  line?: number;
}

export function formatAnnotation(annotation: Annotation): string {
  const props: string[] = [];
  if (annotation.file !== undefined) props.push(`file=${escapeProperty(annotation.file)}`);
  if (annotation.line !== undefined && Number.isInteger(annotation.line) && annotation.line > 0) props.push(`line=${annotation.line}`);
  if (annotation.title !== undefined) props.push(`title=${escapeProperty(annotation.title)}`);
  return `::${annotation.level}${props.length > 0 ? ` ${props.join(",")}` : ""}::${escapeData(annotation.message)}`;
}

/** Append `name=value` pairs to the GITHUB_OUTPUT file using a random heredoc delimiter. */
export function writeOutputs(path: string, outputs: Record<string, string>): void {
  let content = "";
  for (const [name, value] of Object.entries(outputs)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid output name: ${name}`);
    const delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
    if (value.includes(delimiter)) throw new Error("output value collides with its delimiter");
    content += `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  appendFileSync(path, content, { encoding: "utf8" });
}

/** Suspend workflow-command processing while untrusted text may be printed. Returns the resume command. */
export function stopCommands(): { stop: string; resume: string } {
  const token = randomBytes(24).toString("hex");
  return { stop: `::stop-commands::${token}`, resume: `::${token}::` };
}
