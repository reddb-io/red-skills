// working-mode-guard — every shipped skill NAMES the Working mode it serves
// (ADR 0150 §2, issue #4012).
//
// Work enters RedSkills exactly four ways, and until ADR 0150 the skill texts
// described none of them as such:
//
//  1. **interactive** — a human drives a coder CLI in a fresh Worktree, iterates,
//     and lands a PR.
//  2. **spec-driven** — `/start` lands ADRs from a Worktree, `/to-spec` and
//     `/to-tickets` publish Tickets, `/afk` hands the queue to `redskilled`.
//  3. **ad-hoc** — `/go` mints one Ticket and hands it to `redskilled` at once.
//  4. **ADR-editing** — `/adr-editor` lands ADR changes from a fresh Worktree.
//
// A reader who cannot tell which mode a skill serves cannot tell where the work
// will run: interactive and ADR-editing Worktrees stay under the client
// checkout because a human returns to them, while spec-driven and ad-hoc work is
// coordinated by the daemon and its Workers live in OS temporary storage
// (ADR 0149). The mode was inferable from the prose and therefore inferred
// differently by every reader, so ADR 0150 §2 makes it DECLARED: one
// `working-mode:` key in the SKILL.md frontmatter, one of four values.
//
// Three rules the guard holds:
//
//  1. THE HEADER IS THE DECLARATION. Only the YAML frontmatter counts. Prose
//     mentioning "ad-hoc" in the body is documentation, not a declaration, so
//     the scan stops at the closing `---`.
//  2. EXACTLY ONE MODE. A skill that declares none leaves the reader inferring
//     again; a skill that declares two has declared nothing. Both fail, and the
//     failure names the file and the four legal answers.
//  3. THE SOURCE TREE IS THE SUBJECT. Only `plugins/**/SKILL.md` is swept. The
//     `packaging/pi/*/skills/` copies are generated FROM those files, so holding
//     them here would report one defect twice and redden a stale mirror as if it
//     were a missing declaration.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { WORKING_MODES, type WorkingMode } from "@reddb-io/shared/working-mode.js";

// The closed set lives in `@reddb-io/shared` because the daemon reads it too:
// it exports the mode a Worker runs in as `RED_MODE`, and a marker that did not
// spell a mode exactly the way a header declares it would never match.
export { WORKING_MODES, type WorkingMode };

/** The frontmatter key that carries the declaration. */
export const WORKING_MODE_KEY = "working-mode";

/** The one swept root: the plugin source tree, never its generated mirrors. */
export const SKILL_SWEEP_ROOT = "plugins";

/** Directories that never hold a shipped skill source. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "dist-bundle", ".turbo", ".git"]);

/** How a SKILL.md fails to declare exactly one known mode. */
export type WorkingModeDefect = "no-frontmatter" | "missing" | "unknown" | "repeated";

/** One skill whose header does not declare exactly one known Working mode. */
export interface WorkingModeFinding {
  /** Repo-relative path of the offending SKILL.md, `/`-separated. */
  readonly file: string;
  readonly defect: WorkingModeDefect;
  /** Every value the header declared, in header order (empty when none). */
  readonly declared: readonly string[];
  /** One line naming the defect and the repair. */
  readonly reason: string;
}

const LEGAL_ANSWERS = WORKING_MODES.join(", ");

/**
 * The YAML frontmatter block of a markdown source, or `null` when the file does
 * not open with one. PURE.
 */
export function skillFrontmatter(source: string): string | null {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd();
    if (line === "---" || line === "...") return lines.slice(1, index).join("\n");
  }
  return null;
}

/** Strips one layer of matching quotes from a scalar. PURE. */
function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.length > 1 && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Every `working-mode:` value the header declares, in header order. Only
 * top-level frontmatter keys count — an indented line belongs to a block scalar,
 * and a body line is prose. PURE.
 */
export function declaredWorkingModes(source: string): string[] {
  const frontmatter = skillFrontmatter(source);
  if (frontmatter === null) return [];
  const declared: string[] = [];
  for (const line of frontmatter.split("\n")) {
    const match = /^working-mode:(.*)$/.exec(line);
    if (match) declared.push(unquote(match[1] ?? ""));
  }
  return declared;
}

/** True when `value` is one of the four declared modes. PURE. */
export function isWorkingMode(value: string): value is WorkingMode {
  return (WORKING_MODES as readonly string[]).includes(value);
}

/**
 * The finding for one SKILL.md, or `null` when its header declares exactly one
 * known mode. PURE.
 */
export function inspectSkillWorkingMode(file: string, source: string): WorkingModeFinding | null {
  if (skillFrontmatter(source) === null) {
    return {
      file,
      defect: "no-frontmatter",
      declared: [],
      reason: `${file} has no YAML frontmatter, so it cannot declare a Working mode. Open it with a \`---\` block carrying \`${WORKING_MODE_KEY}: <${LEGAL_ANSWERS}>\`.`,
    };
  }

  const declared = declaredWorkingModes(source);
  if (declared.length === 0) {
    return {
      file,
      defect: "missing",
      declared,
      reason: `${file} declares no Working mode. Add \`${WORKING_MODE_KEY}: <${LEGAL_ANSWERS}>\` to its frontmatter (ADR 0150 §2) — a reader must not have to infer where the skill's work runs.`,
    };
  }
  if (declared.length > 1) {
    return {
      file,
      defect: "repeated",
      declared,
      reason: `${file} declares ${declared.length} Working modes (${declared.join(", ")}). A skill that declares two has declared none — keep exactly one of: ${LEGAL_ANSWERS}.`,
    };
  }

  const [only = ""] = declared;
  if (!isWorkingMode(only)) {
    return {
      file,
      defect: "unknown",
      declared,
      reason: `${file} declares the unknown Working mode \`${only}\`. ADR 0150 §1 knows exactly four: ${LEGAL_ANSWERS}.`,
    };
  }
  return null;
}

/**
 * Every shipped `SKILL.md` under the plugin source tree, repo-relative and
 * sorted. A root with no `plugins/` directory yields nothing rather than
 * throwing, so the sweep is safe to point at any checkout.
 */
export function sweptSkillFiles(root: string): string[] {
  const base = join(root, SKILL_SWEEP_ROOT);
  try {
    if (!statSync(base).isDirectory()) return [];
  } catch {
    return [];
  }

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (entry.name === "SKILL.md") found.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(base);
  return found.sort();
}

/** Every swept skill whose header does not declare exactly one known mode. */
export function auditSkillWorkingModes(root: string): WorkingModeFinding[] {
  const findings: WorkingModeFinding[] = [];
  for (const file of sweptSkillFiles(root)) {
    const finding = inspectSkillWorkingMode(file, readFileSync(join(root, file), "utf8"));
    if (finding) findings.push(finding);
  }
  return findings;
}

/** A human-readable failure message naming every offending skill. PURE. */
export function describeWorkingModeFindings(findings: readonly WorkingModeFinding[]): string {
  if (findings.length === 0) return "";
  const rendered = findings.map((finding) => `  - ${finding.reason}`).join("\n");
  return (
    `Working mode declaration: ${findings.length} skill(s) do not declare exactly one mode.\n${rendered}\n` +
    `Legal modes (ADR 0150 §1): ${LEGAL_ANSWERS}. Declared in the SKILL.md frontmatter as \`${WORKING_MODE_KEY}: <mode>\`.`
  );
}
