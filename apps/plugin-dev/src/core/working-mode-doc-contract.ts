// working-mode-doc-contract — a skill that names a Plugin MCP tool is BOUND to a
// tool that exists, and the two thin entrances name no client boot phase
// (ADR 0147 rule 2, ADR 0150 §2–§3, Spec #4007, issue #4030).
//
// The Working mode says WHERE a skill's work runs; this contract says WHAT it
// calls to get there. Both had to become declared for the same reason: a skill
// text is the only thing a reader has, and until now it could name a tool that no
// longer exists, or describe a phase the client no longer runs, and every check in
// the repo stayed green — because prose compiles.
//
// Three rules the guard holds:
//
//  1. A NAMED TOOL EXISTS. Every tool a declaration binds to a skill must be
//     published on the live `rs_dev` surface, and must actually appear in that
//     skill's text. A binding to a tool nobody publishes is a promise the skill
//     cannot keep; a binding to a tool the skill stopped naming is an inventory
//     nobody pruned.
//  2. AN UNDECLARED NAMING IS A GAP. The reverse direction is discovered: any
//     published tool name a swept SKILL.md spells is compared against the
//     declaration, so a skill cannot quietly grow a dependency on a tool. Only
//     names carrying an underscore are DISCOVERED — `status`, `help`, `triage`
//     and `manager` are also ordinary English this repo writes constantly, so a
//     bare-word sweep would report the language rather than the surface. Those
//     are still bindable; they are simply never inferred.
//  3. THE ENTRANCES NAME NO CLIENT BOOT PHASE. ADR 0150 §3 makes `/afk` and `/go`
//     thin: register and arm, or dispatch once, then observe. The phases they used
//     to run first read the human's checkout — the input ADR 0144 §5 forbids — and
//     each became daemon admission or died. A skill that still names one is
//     teaching a reader an architecture nobody decided.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKING_MODES, type WorkingMode } from "@reddb-io/shared/working-mode.js";
import { declaredWorkingModes, sweptSkillFiles } from "./working-mode-guard.js";

/** The Plugin MCPs ADR 0147 rule 2 ships, one per plugin plus the shared one. */
export const PLUGIN_MCP_SERVERS: readonly string[] = ["rs_dev", "rs_github", "rs_memory", "rs_brain"];

/** One skill, its Working mode, and the tools its text commits it to. */
export interface SkillToolBinding {
  /** Repo-relative path of the SKILL.md, `/`-separated. */
  readonly skill: string;
  /** The mode the skill's frontmatter must declare (ADR 0150 §2). */
  readonly mode: WorkingMode;
  /** The Plugin MCP those tools belong to. */
  readonly server: string;
  /** Every tool the skill names, sorted — the binding, in both directions. */
  readonly tools: readonly string[];
  /** One line on what the skill uses them FOR — read by whoever doubts a binding. */
  readonly why: string;
}

/**
 * Every shipped skill that drives a Plugin MCP, bound to the tools it names.
 *
 * The list is deliberately not total over the skill tree: a skill that calls no
 * tool has nothing to bind, and inventing an empty entry for it would make the
 * declaration a census of files rather than a contract about calls.
 */
export const WORKING_MODE_DOC_CONTRACT: readonly SkillToolBinding[] = [
  {
    skill: "plugins/dev/skills/engineering/afk/SKILL.md",
    mode: "spec-driven",
    server: "rs_dev",
    tools: [
      "claim_release",
      "claim_status",
      "daily_review",
      "deadend_audit",
      "events_since",
      "project_activation",
      "project_reset",
      "project_resize",
      "project_start",
      "project_status",
      "project_stop",
      "queue_status",
      "runner_detect",
      "runner_list",
      "runner_steer",
      "unblock_sweep",
      "weekly_review",
      "worker_dispatch",
      "worker_request",
    ],
    why: "register the Project, arm the drain, and observe it — the three steps ADR 0150 §3 leaves the client",
  },
  {
    skill: "plugins/dev/skills/engineering/go/SKILL.md",
    mode: "ad-hoc",
    server: "rs_dev",
    tools: ["events_since", "runner_steer", "worker_dispatch", "worker_request"],
    why: "one dispatch call carrying the approved demand, then the reads that follow the Worker it returned",
  },
  {
    skill: "plugins/dev/skills/engineering/redskilled/SKILL.md",
    mode: "interactive",
    server: "rs_dev",
    tools: [
      "claim_release",
      "claim_status",
      "deadend_audit",
      "events_since",
      "hitl_resolve",
      "project_reset",
      "project_start",
    ],
    why: "the project-side reads a host dossier correlates against the daemon's own host state",
  },
  {
    skill: "plugins/dev/skills/engineering/ask-red/SKILL.md",
    mode: "interactive",
    server: "rs_dev",
    tools: [
      "project_reset",
      "project_status",
      "project_stop",
      "reconcile_engine",
      "runner_detect",
      "runner_list",
      "standing_orders_append",
      "standing_orders_show",
    ],
    why: "the router names the tool each destination is reached by, so a route is callable rather than descriptive",
  },
  {
    skill: "plugins/dev/skills/engineering/audit-skills/SKILL.md",
    mode: "interactive",
    server: "rs_dev",
    tools: ["audit_skills"],
    why: "the ranked scorecard, read and reported without editing a skill",
  },
  {
    skill: "plugins/dev/skills/engineering/daily-review/SKILL.md",
    mode: "spec-driven",
    server: "rs_dev",
    tools: ["daily_review", "weekly_review"],
    why: "one activity-review core entered at whichever window the operator asked for",
  },
  {
    skill: "plugins/dev/skills/engineering/hitl/SKILL.md",
    mode: "spec-driven",
    server: "rs_dev",
    tools: ["hitl_resolve"],
    why: "the atomic park/close/retake disposition with its rationale on the audit trail",
  },
  {
    skill: "plugins/dev/skills/engineering/red-statusline/SKILL.md",
    mode: "interactive",
    server: "rs_dev",
    tools: ["codex_statusline", "statusline_aggregate"],
    why: "the host footer inspection, and the project-side aggregate the command-backed line renders",
  },
  {
    skill: "plugins/dev/skills/engineering/wayfinder/SKILL.md",
    mode: "spec-driven",
    server: "rs_dev",
    tools: ["install_type_labels"],
    why: "the label half and the HUMAN-ONLY declaration half installed as one act (#3013)",
  },
];

/**
 * The client boot phases ADR 0150 §3 removes, as the phrases a skill would spell.
 *
 * Each ran on the client before any work was admitted, and each read the human's
 * checkout to decide what the daemon would then do. `--boot-only` is here because
 * it was the flag that ran them and nothing else.
 *
 * The trust gate is deliberately ABSENT: it did not die, it moved. The daemon
 * admits against it and `queue_status` reports its partition, so a skill naming
 * `held_for_summon` or the allowlist config key is describing a live surface, not
 * a phase it runs first.
 */
export const CLIENT_BOOT_PHASES: readonly string[] = [
  "boot sweep",
  "boot sweeps",
  "docs sweep",
  "boot-only",
  "salvage",
  "precheck",
];

/** The two skills ADR 0150 §3 makes thin, held to {@link CLIENT_BOOT_PHASES}. */
export const THIN_ENTRANCE_SKILLS: readonly string[] = [
  "plugins/dev/skills/engineering/afk/SKILL.md",
  "plugins/dev/skills/engineering/go/SKILL.md",
];

/** How a skill's tool binding fails. */
export type DocContractDefect =
  | "missing-skill"
  | "unpublished-tool"
  | "unnamed-tool"
  | "undeclared-tool"
  | "unknown-server"
  | "mode-mismatch"
  | "client-boot-phase";

/** One defect, with the file it lives in and the repair. */
export interface DocContractFinding {
  readonly skill: string;
  readonly defect: DocContractDefect;
  /** The tool or phrase the defect is about, when there is one. */
  readonly subject?: string;
  readonly reason: string;
}

/** True when `text` names `tool` as a code span, however the span continues. PURE. */
export function namesTool(text: string, tool: string): boolean {
  return text.includes("`" + tool + "`") || text.includes("`" + tool + " ");
}

/**
 * Every published tool name a document spells, restricted to the unambiguous
 * underscore-bearing names (rule 2). PURE.
 */
export function discoveredTools(text: string, published: readonly string[]): string[] {
  return published
    .filter((tool) => tool.includes("_"))
    .filter((tool) => namesTool(text, tool))
    .sort();
}

/** Every binding defect, given the live published tool names. */
export function auditDocContract(
  root: string,
  published: readonly string[],
  contract: readonly SkillToolBinding[] = WORKING_MODE_DOC_CONTRACT,
): DocContractFinding[] {
  const findings: DocContractFinding[] = [];
  const declaredFor = new Map(contract.map((entry) => [entry.skill, entry]));

  for (const entry of contract) {
    const absolute = join(root, ...entry.skill.split("/"));
    if (!existsSync(absolute)) {
      findings.push({
        skill: entry.skill,
        defect: "missing-skill",
        reason: `${entry.skill} is bound to ${entry.server} tools but the file is gone. Remove the binding, or restore the skill.`,
      });
      continue;
    }
    if (!PLUGIN_MCP_SERVERS.includes(entry.server)) {
      findings.push({
        skill: entry.skill,
        defect: "unknown-server",
        subject: entry.server,
        reason: `${entry.skill} is bound to \`${entry.server}\`, which is not a shipped Plugin MCP (${PLUGIN_MCP_SERVERS.join(", ")}).`,
      });
    }

    const text = readFileSync(absolute, "utf8");
    const [mode] = declaredWorkingModes(text);
    if (mode !== entry.mode) {
      findings.push({
        skill: entry.skill,
        defect: "mode-mismatch",
        subject: entry.mode,
        reason: `${entry.skill} declares Working mode \`${mode ?? "none"}\` but the doc contract binds it as \`${entry.mode}\`. One of the two is wrong; the header is what a reader sees first.`,
      });
    }

    for (const tool of entry.tools) {
      if (!published.includes(tool)) {
        findings.push({
          skill: entry.skill,
          defect: "unpublished-tool",
          subject: tool,
          reason: `${entry.skill} names \`${tool}\`, which \`${entry.server}\` does not publish. A skill that names a tool nobody serves sends its reader nowhere.`,
        });
        continue;
      }
      if (!namesTool(text, tool)) {
        findings.push({
          skill: entry.skill,
          defect: "unnamed-tool",
          subject: tool,
          reason: `${entry.skill} is bound to \`${tool}\` but no longer names it. Drop the binding — an inventory nobody prunes is one nobody trusts.`,
        });
      }
    }
  }

  for (const file of sweptSkillFiles(root)) {
    const declared = new Set(declaredFor.get(file)?.tools ?? []);
    const text = readFileSync(join(root, ...file.split("/")), "utf8");
    for (const tool of discoveredTools(text, published)) {
      if (declared.has(tool)) continue;
      findings.push({
        skill: file,
        defect: "undeclared-tool",
        subject: tool,
        reason: `${file} names \`${tool}\` without declaring it. Add it to WORKING_MODE_DOC_CONTRACT so the binding is checked against the live tool surface.`,
      });
    }
  }

  return findings;
}

/** Every client boot phase the thin entrances still name. */
export function auditClientBootPhases(
  root: string,
  skills: readonly string[] = THIN_ENTRANCE_SKILLS,
  phases: readonly string[] = CLIENT_BOOT_PHASES,
): DocContractFinding[] {
  const findings: DocContractFinding[] = [];
  for (const skill of skills) {
    const absolute = join(root, ...skill.split("/"));
    if (!existsSync(absolute)) {
      findings.push({
        skill,
        defect: "missing-skill",
        reason: `${skill} is held to the thin-entrance rule but the file is gone.`,
      });
      continue;
    }
    const text = readFileSync(absolute, "utf8").toLowerCase();
    for (const phase of phases) {
      if (!text.includes(phase)) continue;
      findings.push({
        skill,
        defect: "client-boot-phase",
        subject: phase,
        reason: `${skill} names the client boot phase "${phase}". ADR 0150 §3 makes this entrance thin: it registers or dispatches and then observes, and every phase that read the human's checkout first became daemon admission or died.`,
      });
    }
  }
  return findings;
}

/** A human-readable failure naming every finding and its repair. PURE. */
export function describeDocContractFindings(findings: readonly DocContractFinding[]): string {
  if (findings.length === 0) return "";
  const rendered = findings.map((finding) => `  - [${finding.defect}] ${finding.reason}`).join("\n");
  return (
    `Working-mode doc contract: ${findings.length} finding(s).\n${rendered}\n` +
    `Legal Working modes (ADR 0150 §1): ${WORKING_MODES.join(", ")}. ` +
    "The bindings live in apps/plugin-dev/src/core/working-mode-doc-contract.ts."
  );
}
