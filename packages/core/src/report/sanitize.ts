/**
 * Repository-derived text (file names, test names, source snippets) is untrusted.
 * These helpers make it inert for each output channel.
 */

// C0/C1 control characters (including ESC for ANSI sequences), DEL, and Unicode bidi overrides.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/** Single-line terminal-safe text. */
export function terminalText(text: string, max = 500): string {
  return truncate(text.replace(/\r?\n|\r|\t/g, " ").replace(CONTROL, "�"), max);
}

/** Markdown/HTML-safe inline text for GitHub Step Summaries. */
export function markdownText(text: string, max = 500): string {
  return terminalText(text, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/([\\`*_{}[\]()#+\-!|~])/g, "\\$1")
    .replace(/@/g, "@​");
}
