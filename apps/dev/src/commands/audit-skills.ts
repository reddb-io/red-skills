// commands/audit-skills.ts — the IO half of `dev audit-skills` (issue #1167).
//
// A user-invoked, READ-ONLY skill-quality auditor. It enumerates every shipped
// SKILL.md, scores each against our own house style (mechanical checks + an LLM
// judge on the dev review engine), overlays best-effort memory telemetry to rank
// worst-first, and prints a scorecard. ZERO side effects — no git, no gh, no
// labels, no backlog, no --fix. The command has no push/gh seam by construction.
//
// Output mirrors /red-doctor Pass 1: one row per skill (glyph, composite score, top
// finding, telemetry tag when present), sorted worst-first, then a short
// prioritized recommendation list. Agent-facing/--json renders TOON (ADR 0089);
// a TTY renders a human table.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Output } from "@reddb-io/worker";
import { encode as encodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";
import { loadConfig, getConfig, resolveTier } from "../core/config.js";
import { resolveConfigPath } from "./route-model-tier.js";
import { defaultSandcastleDeps, type AgentRunner } from "../core/execution.js";
import {
  runMechanicalChecks,
  scoreSkill,
  rankSkills,
  type SkillDoc,
  type SkillScore,
  type SkillAuditFindings,
  type TelemetryTag,
} from "../core/skill-audit.js";
import { makeExtractSkillAudit, skillAuditSchema } from "../core/skill-audit-extract.js";

/** The meta-skill is self-exempt from its own rules — never audit it. */
const SELF_EXEMPT = new Set(["writing-for-agents"]);

interface AuditFlags {
  format: "toon" | "json" | "human";
  runner?: string;
  root: string;
  /** When set, skip the LLM judge (mechanical-only; faster, no provider). */
  mechanicalOnly: boolean;
}

function parseAuditFlags(args: readonly string[], cwd: string): AuditFlags {
  // Default agent-facing (TOON) unless a TTY is attached (human table).
  let format: AuditFlags["format"] = process.stdout.isTTY ? "human" : "toon";
  let runner: string | undefined;
  let root = cwd;
  let mechanicalOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") format = "json";
    else if (arg === "--toon") format = "toon";
    else if (arg === "--human") format = "human";
    else if (arg === "--mechanical-only") mechanicalOnly = true;
    else if (arg === "--runner") runner = args[++i];
    else if (arg.startsWith("--runner=")) runner = arg.slice("--runner=".length);
    else if (arg === "--root") root = args[++i] ?? cwd;
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else throw new Error(`unknown audit-skills argument: ${arg}`);
  }
  return { format, runner, root, mechanicalOnly };
}

function isRunner(value: string): value is AgentRunner {
  return value === "claude" || value === "codex" || value === "opencode";
}

/** Recursively list files matching a predicate under `dir` (repo-relative). */
async function walk(root: string, dir: string, keep: (rel: string) => boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walk(root, rel, keep, out);
    } else if (keep(rel)) {
      out.push(rel);
    }
  }
}

/** The plugins/<name> ancestor of a repo-relative path, or "". */
function pluginRoot(rel: string): string {
  const m = rel.match(/^(plugins\/[^/]+)\//);
  return m ? m[1]! : "";
}

/**
 * Enumerate shipped skills + compute per-skill orphaned bundled files. Mirrors
 * the lint glob (find plugins -name SKILL.md, excluding any in-progress/ path),
 * minus the self-exempt meta-skill. Orphan detection widens the reference
 * search to every shipped markdown file in the same plugin (as the lint does),
 * so extracted sibling reference docs can own links too.
 */
export async function enumerateSkills(
  root: string,
): Promise<Array<{ doc: SkillDoc; orphanedFiles: string[] }>> {
  const skillPaths: string[] = [];
  await walk(root, "plugins", (rel) => rel.endsWith("/SKILL.md") && !rel.includes("/in-progress/"), skillPaths);
  skillPaths.sort();

  // Bundled non-README markdown, for orphan detection.
  const bundled: string[] = [];
  await walk(
    root,
    "plugins",
    (rel) =>
      rel.includes("/skills/") &&
      rel.endsWith(".md") &&
      !rel.endsWith("/SKILL.md") &&
      !rel.endsWith("/README.md") &&
      !rel.includes("/in-progress/"),
    bundled,
  );

  // Cache each SKILL.md's content once for audit.
  const contents = new Map<string, string>();
  for (const p of skillPaths) contents.set(p, await readFile(path.join(root, p), "utf8"));

  // Cache every shipped plugin markdown file once for reference search.
  const referencePaths = [...new Set([...skillPaths, ...bundled])].sort();
  const referenceContents = new Map<string, string>();
  for (const p of referencePaths) referenceContents.set(p, await readFile(path.join(root, p), "utf8"));

  const result: Array<{ doc: SkillDoc; orphanedFiles: string[] }> = [];
  for (const p of skillPaths) {
    const skillDir = path.posix.dirname(p);
    const proot = pluginRoot(p);
    if (SELF_EXEMPT.has(path.posix.basename(skillDir))) continue;

    const orphanedFiles = bundled
      .filter((b) => path.posix.dirname(b) === skillDir)
      .filter((b) => {
        const base = path.posix.basename(b);
        // Referenced if any other shipped markdown file in the plugin mentions the basename.
        for (const [rp, content] of referenceContents) {
          if (rp !== b && rp.startsWith(`${proot}/`) && content.includes(base)) return false;
        }
        return true;
      })
      .map((b) => path.posix.basename(b));

    result.push({ doc: { path: p, content: contents.get(p)! }, orphanedFiles });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering (mirrors /red-doctor Pass 1).
// ---------------------------------------------------------------------------

const GLYPH: Record<SkillScore["glyph"], string> = { pass: "✓", warn: "⚠", fail: "✗" };

function scoreToRow(s: SkillScore): Record<string, ToonValue> {
  return {
    glyph: GLYPH[s.glyph],
    score: s.composite,
    skill: s.name,
    telemetry: s.telemetry ?? "-",
    top_finding: s.topFinding,
  };
}

function recommendations(ranked: readonly SkillScore[]): string[] {
  const recs: string[] = [];
  for (const s of ranked) {
    if (s.glyph === "pass") continue;
    const suggestion = s.findings?.suggestions?.[0];
    recs.push(`${s.name} (${s.composite}): ${suggestion ?? s.topFinding}`);
    if (recs.length >= 10) break;
  }
  return recs;
}

export function renderAuditToon(ranked: readonly SkillScore[]): string {
  return encodeToon({
    audited: ranked.length,
    skills: ranked.map(scoreToRow),
    recommendations: recommendations(ranked),
  });
}

export function renderAuditHuman(ranked: readonly SkillScore[]): string {
  const lines: string[] = [];
  lines.push(`Skill quality audit — ${ranked.length} skill(s), worst-first`);
  lines.push("");
  for (const s of ranked) {
    const tel = s.telemetry ? ` [${s.telemetry}]` : "";
    const sem = s.semantic === null ? "mech-only" : `sem ${s.semantic}`;
    lines.push(`${GLYPH[s.glyph]} ${String(s.composite).padStart(3)}  ${s.name}${tel}  (${sem}) — ${s.topFinding}`);
  }
  const recs = recommendations(ranked);
  if (recs.length > 0) {
    lines.push("");
    lines.push("Prioritized recommendations:");
    for (const r of recs) lines.push(`  • ${r}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command entry.
// ---------------------------------------------------------------------------

export interface AuditDeps {
  enumerate: (root: string) => Promise<Array<{ doc: SkillDoc; orphanedFiles: string[] }>>;
  /** The LLM judge; null when mechanical-only or when extraction fails. */
  judge: ((doc: SkillDoc, runner: AgentRunner) => Promise<SkillAuditFindings>) | null;
  /** Best-effort behavioral telemetry, keyed by skill name. Empty = store absent. */
  telemetry: () => Promise<Map<string, TelemetryTag>>;
  runner: AgentRunner;
}

/** The pure orchestration: enumerate → mechanical + judge per skill → overlay
 * telemetry → rank. Extracted so tests drive it with a stubbed judge. */
export async function runAudit(root: string, deps: AuditDeps): Promise<SkillScore[]> {
  const skills = await deps.enumerate(root);
  const telemetry = await deps.telemetry().catch(() => new Map<string, TelemetryTag>());
  const scores: SkillScore[] = [];
  for (const { doc, orphanedFiles } of skills) {
    const checks = runMechanicalChecks(doc, { orphanedFiles });
    let findings: SkillAuditFindings | null = null;
    if (deps.judge) {
      try {
        findings = await deps.judge(doc, deps.runner);
      } catch {
        findings = null; // Judge failure degrades to mechanical-only for this skill.
      }
    }
    const name = doc.path.split("/").slice(-2)[0]!;
    scores.push(scoreSkill({ doc, checks, findings, telemetry: telemetry.get(name) }));
  }
  return rankSkills(scores);
}

/**
 * `audit-skills [--json|--toon|--human] [--mechanical-only] [--runner R]` — run
 * the read-only skill-quality audit and print the scorecard. Never mutates.
 */
export async function auditSkillsCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  let flags: AuditFlags;
  try {
    flags = parseAuditFlags(args, cwd);
  } catch (error) {
    process.stderr.write(`[audit-skills] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const config = loadConfig(resolveConfigPath(flags.root), { warn: () => undefined });
  const configRunner = getConfig(config, "afk.default_runner") || "claude";
  const runnerCandidate = flags.runner ?? configRunner;
  const runner: AgentRunner = isRunner(runnerCandidate) ? runnerCandidate : "claude";

  let judge: AuditDeps["judge"] = null;
  if (!flags.mechanicalOnly) {
    const tier = resolveTier(config, runner, "complex", process.env);
    const sandcastle = await defaultSandcastleDeps();
    judge = makeExtractSkillAudit(
      {
        run: sandcastle.run as Parameters<typeof makeExtractSkillAudit>[0]["run"],
        agentFor: sandcastle.agentFor,
        sandboxFor: (mode) => sandcastle.sandboxFor(mode),
        output: ({ tag, maxRetries }) => Output.object({ tag, schema: skillAuditSchema, maxRetries }),
        cwd: flags.root,
      },
      { model: tier.model, effort: tier.effort },
    );
  }

  let ranked: SkillScore[];
  try {
    ranked = await runAudit(flags.root, {
      enumerate: enumerateSkills,
      judge,
      // Telemetry overlay is best-effort. The dev app has no memory dependency,
      // so it degrades cleanly to score-only ranking (store absent).
      telemetry: async () => new Map<string, TelemetryTag>(),
      runner,
    });
  } catch (error) {
    process.stderr.write(`[audit-skills] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (flags.format === "json") {
    stdout.write(`${JSON.stringify({ audited: ranked.length, skills: ranked.map(scoreToRow) }, null, 2)}\n`);
  } else if (flags.format === "human") {
    stdout.write(`${renderAuditHuman(ranked)}\n`);
  } else {
    stdout.write(`${renderAuditToon(ranked)}\n`);
  }
  return 0;
}
