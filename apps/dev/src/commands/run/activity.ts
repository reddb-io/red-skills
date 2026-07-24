import type { AgentStreamEvent } from "../../core/execution.js";

/**
 * Map a sandcastle agent stream event to an AFK activity, or `undefined`
 * when the event carries no activity signal (a text chunk, reasoning event, or an
 * unrecognised tool). Mirrors the shell activity-detection table against tool
 * calls: Edit/Write → `impl`, Read/Grep/`git ls-files`/`find` → `explore`,
 * runner commands → their matching command activity. Reasoning events return
 * `undefined` — they interleave every tool call on thinking-heavy runners
 * (Opus effort=high) and carry no exclusive activity signal; returning `undefined`
 * prevents them from clobbering a concrete activity already set by the preceding
 * tool call. Used by `recordAgentEvent` to advance `current.activity` in
 * afk.state.toon so the monitor reflects progress.
 */
type DerivedActivity =
  | "explore"
  | "impl"
  | "tests"
  | "commit"
  | "typecheck"
  | "lint"
  | "build"
  | "push"
  | "review";

type ActivityPattern = {
  readonly activity: DerivedActivity;
  readonly pattern: RegExp;
};

const TOOL_NAME_ACTIVITY_PATTERNS: readonly ActivityPattern[] = [
  { activity: "impl", pattern: /^(edit|write|multiedit|notebookedit)$/ },
  { activity: "explore", pattern: /^(read|grep|glob)$/ },
];

const COMMAND_ACTIVITY_PATTERNS: readonly ActivityPattern[] = [
  { activity: "commit", pattern: /\bgit\s+commit(?:\s|$)/ },
  { activity: "push", pattern: /\bgit\s+push(?:\s|$)/ },
  { activity: "review", pattern: /\bgit\s+(?:diff|log|show)(?:\s|$)/ },

  { activity: "build", pattern: /\btsc\s+--build\b/ },
  { activity: "build", pattern: /\b(?:npm|pnpm|yarn|bun)(?:(?![;&|]).)*\bbuild\b/ },
  { activity: "build", pattern: /\bvite\s+build\b/ },
  { activity: "build", pattern: /\bcargo\s+build\b/ },
  { activity: "build", pattern: /\bgo\s+build\b/ },
  { activity: "build", pattern: /\bmake\b/ },
  { activity: "build", pattern: /\bgradle(?:(?![;&|]).)*\bbuild\b/ },
  { activity: "build", pattern: /\bmvn(?:(?![;&|]).)*\bpackage\b/ },
  { activity: "build", pattern: /\bdotnet\s+build\b/ },
  { activity: "build", pattern: /\bcmake\b/ },
  { activity: "build", pattern: /\bbazel\s+build\b/ },
  { activity: "build", pattern: /\bzig\s+build\b/ },
  { activity: "build", pattern: /\bdart\s+compile\b/ },

  { activity: "typecheck", pattern: /\b(?:npm|pnpm|yarn|bun)(?:(?![;&|]).)*\btypecheck\b/ },
  { activity: "typecheck", pattern: /\btsc\b(?!\s+--build\b)/ },
  { activity: "typecheck", pattern: /\b(?:mypy|pyright)\b/ },
  { activity: "typecheck", pattern: /\bcargo\s+check\b/ },
  { activity: "typecheck", pattern: /\bdart\s+analyze\b/ },

  { activity: "lint", pattern: /\b(?:eslint|biome)\b/ },
  { activity: "lint", pattern: /\bprettier\b(?:(?![;&|]).)*\b--check\b/ },
  { activity: "lint", pattern: /\bcargo\s+clippy\b/ },
  { activity: "lint", pattern: /\b(?:ruff|flake8|pylint)\b/ },
  { activity: "lint", pattern: /\bblack\b(?:(?![;&|]).)*\b--check\b/ },
  { activity: "lint", pattern: /\brubocop\b/ },
  { activity: "lint", pattern: /\bgolangci-lint\b/ },
  { activity: "lint", pattern: /\bgo\s+vet\b/ },
  { activity: "lint", pattern: /\bgofmt\b/ },
  { activity: "lint", pattern: /\b(?:ktlint|checkstyle)\b/ },
  { activity: "lint", pattern: /\bclang-tidy\b/ },
  { activity: "lint", pattern: /\bdotnet\s+format\b/ },
  { activity: "lint", pattern: /\bdart\s+analyze\b/ },

  { activity: "tests", pattern: /\b(?:vitest|jest|mocha)\b/ },
  { activity: "tests", pattern: /\b(?:npm|pnpm|yarn|bun)(?:(?![;&|]).)*\btest\b/ },
  { activity: "tests", pattern: /\bcargo\s+test\b/ },
  { activity: "tests", pattern: /\bgo\s+test\b/ },
  { activity: "tests", pattern: /\bpytest\b/ },
  { activity: "tests", pattern: /\bpython(?:\d+(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)\b/ },
  { activity: "tests", pattern: /\bunittest\b/ },
  { activity: "tests", pattern: /\bphpunit\b/ },
  { activity: "tests", pattern: /\bgradle(?:(?![;&|]).)*\btest\b/ },
  { activity: "tests", pattern: /\bmvn(?:(?![;&|]).)*\btest\b/ },
  { activity: "tests", pattern: /\bdotnet\s+test\b/ },
  { activity: "tests", pattern: /\bctest\b/ },
  { activity: "tests", pattern: /\bdart\s+test\b/ },
  { activity: "tests", pattern: /\bzig\s+test\b/ },

  { activity: "explore", pattern: /\bgit\s+ls-files(?:\s|$)/ },
  { activity: "explore", pattern: /\bfind\b/ },
];

export function deriveActivity(event: AgentStreamEvent): string | undefined {
  if (event.type !== "toolCall") return undefined;
  const name = event.name.toLowerCase();
  const args = event.formattedArgs.toLowerCase();
  // Tool-name classification wins for file tools BEFORE the loose args `test`
  // match (#589): reading/grepping/editing a path that merely CONTAINS "test"
  // (e.g. `src/test-utils.ts`) is explore/impl, not a test run. The `\btest\b`
  // args check below is for command tools running an actual test runner.
  for (const rule of TOOL_NAME_ACTIVITY_PATTERNS) {
    if (rule.pattern.test(name)) return rule.activity;
  }
  for (const rule of COMMAND_ACTIVITY_PATTERNS) {
    if (rule.pattern.test(args)) return rule.activity;
  }
  return undefined;
}
