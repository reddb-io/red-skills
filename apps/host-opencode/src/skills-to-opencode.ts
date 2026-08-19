/**
 * skills-to-opencode.ts — pure planner for the `SKILL.md` → opencode
 * skill directory mapping (ADR 0076).
 *
 * Reads the RedSkills `plugins/<plugin>/skills/<bucket>/<name>/SKILL.md`
 * tree and returns a {@link SkillPlan} list the emit step turns into
 * either a relative symlink or a copied file under
 * `dist/opencode/<plugin>/.opencode/skills/<name>/SKILL.md`.
 *
 * No `fs` writes happen here. The planner is pure: same input tree
 * always produces the same plan. The emit orchestration (in `emit.ts`)
 * is the thin shell that takes the plan and touches the filesystem;
 * keeping the planner pure makes the name/frontmatter validation rules
 * unit-testable with no filesystem mocking.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/** A planned `SKILL.md` symlink/copy. */
export interface SkillPlan {
  /** Absolute path to the source `SKILL.md` (read-only). */
  source: string;
  /** Path to write under `dist/opencode/<plugin>/.opencode/skills/...`,
   *  relative to the emit root. Always ends in `/SKILL.md`. */
  target: string;
  /** The flat skill name (the directory name under `skills/`). */
  name: string;
  /** The bucket the source came from (`engineering`, `knowledge`, …). */
  bucket: string;
  /** Set when the flat name collided with another plugin's skill and the
   *  plan was disambiguated to `<plugin>-<name>`: the source's frontmatter
   *  `name:` (the original) must be rewritten in the emitted copy, because
   *  opencode keys skills by frontmatter name, not by directory. */
  renamedFrom?: string;
}

/** A validation error from the planner. */
export interface SkillError {
  /** The path the error is about (the offending directory or file). */
  path: string;
  /** The skill name if known. */
  name?: string;
  /** A stable error code (used by callers to filter/route). */
  code:
    | "name-not-valid"
    | "name-not-equal-to-dir"
    | "frontmatter-missing"
    | "name-missing"
    | "description-missing-or-too-long";
  /** Human-readable detail. */
  message: string;
}

export interface PlanResult {
  plans: SkillPlan[];
  errors: SkillError[];
}

/**
 * opencode's name rule (verified against the opencode Agent Skills
 * doc, June 2026): 1-64 chars, lowercase alphanumeric with single
 * hyphens as separators, no leading/trailing/consecutive hyphens.
 * Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`.
 */
const NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** opencode's `description` length budget, inclusive. */
const DESCRIPTION_MAX = 1024;

/** Buckets the generator skips — drafts only. */
const SKIP_BUCKETS = new Set(["in-progress"]);

/** Split a path returned by node:path.relative on either host family. */
export function skillRelativeParts(path: string): string[] {
  return path.split(/[\\/]/);
}

/**
 * Parse a RedSkills `SKILL.md` and return the `name` and `description`
 * from the YAML frontmatter. The RedSkills SKILL.md uses a constrained
 * subset of YAML (the same grammar the shared `plugin-gate.ts` uses),
 * so we parse it without a YAML dependency.
 */
export function parseFrontmatter(text: string): {
  name?: string;
  description?: string;
} {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  let name: string | undefined;
  let description: string | undefined;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }
  return { name, description };
}

/** Return every `SKILL.md` under `plugins/<plugin>/skills/...`, recursively,
 *  keyed by absolute source path. Excludes `in-progress/`. */
export function listSkillFiles(pluginsRoot: string, plugin: string): string[] {
  const skillsRoot = join(pluginsRoot, plugin, "skills");
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];
  const stack: string[] = [skillsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (SKIP_BUCKETS.has(basename(abs))) continue;
        stack.push(abs);
      } else if (s.isFile() && entry === "SKILL.md") {
        out.push(abs);
      }
    }
  }
  return out;
}

/**
 * Build the skill plan for a single source `SKILL.md`. Returns the plan
 * plus any errors that should fail the build. Errors do not throw — the
 * caller decides whether to surface them as warnings or fail-closed.
 */
export function planSkill(source: string, pluginsRoot: string, plugin: string): {
  plan?: SkillPlan;
  errors: SkillError[];
} {
  const errors: SkillError[] = [];
  const name = basename(dirname(source));
  const bucket = basename(dirname(dirname(source)));
  const rel = relative(join(pluginsRoot, plugin, "skills"), source);
  // Expected layout: <bucket>/<name>/SKILL.md. The bucket must NOT be
  // `in-progress/` (filtered earlier) and must NOT be a flat SKILL.md
  // at the skills/ root.
  const parts = skillRelativeParts(rel);
  if (parts.length !== 3 || parts[2] !== "SKILL.md") {
    errors.push({
      path: source,
      name,
      code: "name-not-valid",
      message: `${rel} is not in the expected <bucket>/<name>/SKILL.md layout`,
    });
    return { errors };
  }
  if (!NAME_REGEX.test(name) || name.length > 64) {
    errors.push({
      path: source,
      name,
      code: "name-not-valid",
      message: `name "${name}" violates opencode's name rule: 1-64 chars, lowercase alphanumeric with single-hyphen separators (regex ^[a-z0-9]+(-[a-z0-9]+)*$)`,
    });
    return { errors };
  }
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (err) {
    errors.push({
      path: source,
      name,
      code: "frontmatter-missing",
      message: `could not read ${source}: ${(err as Error).message}`,
    });
    return { errors };
  }
  const { name: fmName, description } = parseFrontmatter(text);
  if (!fmName) {
    errors.push({
      path: source,
      name,
      code: "name-missing",
      message: `frontmatter is missing the required \`name:\` field`,
    });
  } else if (fmName !== name) {
    errors.push({
      path: source,
      name,
      code: "name-not-equal-to-dir",
      message: `frontmatter name "${fmName}" does not match directory name "${name}" — opencode will refuse to load this skill`,
    });
  }
  if (!description) {
    errors.push({
      path: source,
      name,
      code: "description-missing-or-too-long",
      message: `frontmatter is missing the required \`description:\` field`,
    });
  } else if (description.length > DESCRIPTION_MAX) {
    errors.push({
      path: source,
      name,
      code: "description-missing-or-too-long",
      message: `frontmatter description is ${description.length} chars, opencode's budget is ${DESCRIPTION_MAX}`,
    });
  }
  if (errors.length > 0) return { errors };
  return {
    plan: { source, target: `skills/${name}/SKILL.md`, name, bucket },
    errors: [],
  };
}

/** Plan all skills for a single plugin. */
export function planPluginSkills(pluginsRoot: string, plugin: string): PlanResult {
  const plans: SkillPlan[] = [];
  const errors: SkillError[] = [];
  for (const source of listSkillFiles(pluginsRoot, plugin)) {
    const { plan, errors: es } = planSkill(source, pluginsRoot, plugin);
    if (plan) plans.push(plan);
    errors.push(...es);
  }
  plans.sort((a, b) => a.target.localeCompare(b.target));
  return { plans, errors };
}

/** Plan all skills across every plugin under `pluginsRoot`. */
export function planAllSkills(
  pluginsRoot: string,
  plugins: string[],
): { plugin: string; result: PlanResult }[] {
  const planned = plugins.map((plugin) => ({ plugin, result: planPluginSkills(pluginsRoot, plugin) }));
  disambiguateCollisions(planned);
  return planned;
}

/**
 * OpenCode's skill namespace is flat: Claude's `memory:view` and `brain:view`
 * would both land as `view`, and the later one silently overwrote the earlier
 * (the global installer only logged a "duplicate skipped" note). Every skill
 * whose flat name is claimed by more than one plugin is renamed
 * `<plugin>-<name>` — all parties, not just the loser, so the result does not
 * depend on plugin order — and marked `renamedFrom` so the emitter rewrites
 * the frontmatter name in a copy. Names claimed once are untouched.
 */
export function disambiguateCollisions(planned: { plugin: string; result: PlanResult }[]): void {
  const claimants = new Map<string, Set<string>>();
  for (const { plugin, result } of planned) {
    for (const plan of result.plans) {
      if (!claimants.has(plan.name)) claimants.set(plan.name, new Set());
      claimants.get(plan.name)!.add(plugin);
    }
  }
  for (const { plugin, result } of planned) {
    for (const plan of result.plans) {
      if ((claimants.get(plan.name)?.size ?? 0) < 2) continue;
      const renamed = `${plugin}-${plan.name}`;
      plan.renamedFrom = plan.name;
      plan.name = renamed;
      plan.target = `skills/${renamed}/SKILL.md`;
    }
    result.plans.sort((a, b) => a.target.localeCompare(b.target));
  }
}

/** Rewrite the frontmatter `name:` of a source SKILL.md for a renamed plan. */
export function renameSkillFrontmatter(text: string, renamed: string): string {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return text;
  const block = match[1]!;
  const rewritten = block.replace(/^name:.*$/m, `name: ${renamed}`);
  return text.replace(block, rewritten);
}
