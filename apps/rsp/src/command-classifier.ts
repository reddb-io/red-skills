/**
 * The one command classifier for every rsp surface.
 *
 * The pre-exec hook (`intercept.ts`), the universal proxy (`proxy.ts`), and
 * telemetry reporting (`telemetry/reports.ts`) all read command shape through
 * this module, so a `command_family` telemetry key means the same thing no
 * matter which surface minted it. Classification answers "what shape is this
 * command?" and nothing else — deciding how to *invoke* rsp (binary
 * resolution, invocation prefix) stays with the surface that runs commands.
 *
 * Adding a family here changes telemetry keys everywhere at once; pin the new
 * key in `tests/command-classifier.test.ts`.
 */

/** Splits a command into whitespace-separated words, dropping empty runs. */
export function commandWords(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Splits a command line into shell segments on `&&`, `;`, and `|`. */
export function commandSegments(command: string): string[] {
  return command.split(/&&|[;|]/).map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Splits one segment into words on spaces and tabs. A leading `env` keyword is
 * blanked rather than dropped, so callers reading `tokens[0]` see an empty
 * command word and treat the segment as ambiguous.
 */
export function shellishWords(segment: string): string[] {
  return segment.split(/[ \t]+/).filter(Boolean).map((token) => token.replace(/^env$/, ""));
}

/** The telemetry `command_family` key for a raw command string. */
export function commandFamily(command: string): string {
  const parts = commandWords(command);
  if (parts.length === 0) return "unknown";
  if (parts[0] === "git" && parts[1]) return `git ${parts[1]}`;
  if (isGhJsonJqSelection(parts) && parts[1] && parts[2]) return `gh ${parts[1]} ${parts[2]} json-jq`;
  if (isGhJsonJqSelection(parts) && parts[1]) return `gh ${parts[1]} json-jq`;
  if (isGhJsonJqSelection(parts)) return "gh json-jq";
  if (parts[0] === "gh" && parts[1] && parts[2]) return `gh ${parts[1]} ${parts[2]}`;
  if (parts[0] === "gh" && parts[1]) return `gh ${parts[1]}`;
  if (parts[0] === "cargo" && parts[1]) return `cargo ${parts[1]}`;
  if (parts[0] === "vitest") return "vitest";
  return parts[0]!;
}

/** True when the tokens are a `gh` call whose output is already a selection. */
export function isGhJsonJqSelection(tokens: readonly string[]): boolean {
  return tokens[0] === "gh" && tokens.some(isJsonJqSelectionFlag);
}

export function isJsonJqSelectionFlag(token: string): boolean {
  return token === "--json" || token === "--jq" || token.startsWith("--json=") || token.startsWith("--jq=");
}

export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}
