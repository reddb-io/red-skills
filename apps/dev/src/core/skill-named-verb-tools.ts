// skill-named-verb-tools — the rule ADR 0147 §1 states, made countable
// (Spec #4007, issue #4024).
//
// The dev CLI is deleted, not deprecated, and the ADR draws the line through the
// middle of its 36 commands: **a command some skill still names becomes a tool of
// the plugin's MCP; a command no skill names dies with the bundle.** Both halves
// are enforceable only if somebody writes down which side each command is on, so
// this module IS that ledger — the named verbs with the `rs_dev` tool that carries
// their core, and the unnamed commands with the route that outlives them.
//
// **A SKILL IS THE ONLY WITNESS THAT KEEPS A VERB ALIVE.** Not the router, not the
// test suite, not a habit: a shipped skill telling an agent to run it. So the
// named half was DISCOVERED, by sweeping the shipped skill tree, and only the
// mapping was declared.
//
// **The sweep has since run to zero** (issue #4030): every skill that named a verb
// now names the tool, so the ratchet's live assertion is the stronger one — NO
// shipped skill names the deleted binary at all. What the discovery produced stays
// here as the PROMOTION LEDGER: each verb beside the tool that inherited its core,
// pinned against the composed `rs_dev` surface so a promoted core cannot quietly
// leave it. Deleting an entry is deleting the capability, not tidying a list.
//
// The declaration deliberately does not spell the dying binary: the one literal
// lives in `bare-invocation-guard.ts` beside the other sweep that hunts it, so the
// two cannot drift onto different tokens.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEV_CLI_BINARY } from "./bare-invocation-guard.js";

/** One verb a shipped skill still names, and the `rs_dev` tool that carries it. */
export interface SkillNamedVerbTool {
  /** The verb as a skill spells it on the command line. */
  readonly verb: string;
  /** The published `rs_dev` tool name that answers the same core. */
  readonly tool: string;
  /** Why that tool is the same core — read by whoever doubts the pairing. */
  readonly why: string;
}

/**
 * The promotion ledger: every verb a shipped skill named when the sweep last found
 * one, paired with the `rs_dev` tool that inherited its core.
 *
 * A pairing is by CORE, not by spelling: `monitor` becomes `status {scope: worker}`
 * because the monitor contract is exactly what that scope returns, and `go` becomes
 * `worker_dispatch` because minting and running one disposable demand is the same
 * operation the verb performed. Where the core has no tool yet, the tool is the one
 * this slice added.
 */
export const SKILL_NAMED_VERB_TOOLS: readonly SkillNamedVerbTool[] = [
  {
    verb: "audit-skills",
    tool: "audit_skills",
    why: "the ranked skill-audit scores, returned instead of rendered as a table",
  },
  {
    verb: "codex-monitor-agent",
    tool: "codex_monitor_agent",
    why: "the read-only Codex monitor prompt, returned as the value the host pastes",
  },
  {
    verb: "codex-statusline",
    tool: "codex_statusline",
    why: "the Codex footer-preference inspection over the same host configuration",
  },
  {
    verb: "daily-review",
    tool: "daily_review",
    why: "one activity-review core, entered at the day window",
  },
  {
    verb: "dashboard",
    tool: "dashboard",
    why: "the operational dashboard over a period window",
  },
  {
    verb: "go",
    tool: "worker_dispatch",
    why: "minting and running one disposable demand is what the verb did; `demand` is that argument",
  },
  {
    verb: "install-type-labels",
    tool: "install_type_labels",
    why: "the label half and the HUMAN-ONLY declaration half, applied as one act (#3013)",
  },
  {
    verb: "manager",
    tool: "manager",
    why: "the Manager's own intake, routing, artifact, status and checkpoint surface",
  },
  {
    verb: "monitor",
    tool: "status",
    why: "`scope: worker` returns the monitor contract itself, beside worker status and vitals",
  },
  {
    verb: "reconcile-engine",
    tool: "reconcile_engine",
    why: "the engine-delivery reconciliation report",
  },
  {
    verb: "red-doctor",
    tool: "red_doctor",
    why: "every doctor finding for this repository, each paired with the route that repairs it",
  },
  {
    verb: "requeue",
    tool: "requeue",
    why: "the complete parked-issue requeue transition",
  },
  {
    verb: "retake",
    tool: "retake",
    why: "the issue, PR, branch, worktree and worker-state report plus the recommended action",
  },
  {
    verb: "statusline",
    tool: "statusline_aggregate",
    why: "the same collector cores the command-backed statusLine renders, as structured data",
  },
  {
    verb: "triage",
    tool: "triage",
    why: "the decided triage transition, gated by the per-repo trust policy",
  },
  {
    verb: "weekly-review",
    tool: "weekly_review",
    why: "one activity-review core, entered at the week window",
  },
];

/** One command no shipped skill names, and where its capability lives instead. */
export interface UnnamedDevCommand {
  /** The verb as the router spells it. */
  readonly command: string;
  /** The route that outlives it — a tool, a binary, a hook, or nothing. */
  readonly route: string;
}

/**
 * The deletion list: every command the sweep finds no shipped skill naming.
 *
 * Recorded rather than deleted here, because deleting the router is the follow-up
 * slice's job and a list somebody wrote down is what makes that slice measurable.
 * Each entry states the route, and "no successor" is a legal answer — several of
 * these are hook payload handlers and internal boundaries that were never operator
 * verbs, and one (`version`) is answered by every shipped binary already.
 */
export const UNNAMED_DEV_COMMANDS: readonly UnnamedDevCommand[] = [
  {
    command: "run",
    route: "`redskilled acp-worker` running `@reddb-io/worker` — the one Worker body (ADR 0148)",
  },
  {
    command: "project",
    route: "the `drain`, `project_start`, `project_resize`, `project_reset` and `project_stop` tools",
  },
  {
    command: "stop",
    route: "`project_stop` for the registration, `worker_stop` for one process tree",
  },
  {
    command: "afk-output-shaping",
    route: "no successor — an opt-in phrasing experiment read from worker state (#1638)",
  },
  { command: "reap", route: "the `reap` tool" },
  {
    command: "orphan-branches",
    route: "the `reap` tool, which classifies and deletes the same branches",
  },
  {
    command: "path-brief",
    route: "no successor — a host hook payload handler, never an operator verb",
  },
  { command: "worktree", route: "the `worktree_list` and `worktree_remove` tools" },
  {
    command: "redact-sweep",
    route: "no successor — a maintenance sweep run from a checkout",
  },
  {
    command: "relabel-sweep",
    route: "no successor — a one-off tracker migration",
  },
  {
    command: "review",
    route: "the `daily_review` and `weekly_review` tools over the same activity core",
  },
  { command: "respond", route: "the `respond` tool" },
  {
    command: "hitl-card",
    route: "`hitl_resolve` for the decision; the card itself is posted by the engine, not by an operator",
  },
  {
    command: "route-model-tier",
    route: "no successor — a host hook payload handler for subagent dispatch",
  },
  {
    command: "rsp-instructions",
    route: "no successor — the session-start injection ADR 0147 rule 4 switched off",
  },
  {
    command: "inject-development-workflow",
    route: "`/red-setup`, which owns every write into a repository's agent rules",
  },
  {
    command: "toon-bump",
    route: "no successor — a repo-local serialization migration",
  },
  {
    command: "toon-migrate",
    route: "no successor — a plugin-store serialization migration run from bootstrap",
  },
  {
    command: "worker-gh",
    route: "the daemon's GitHub gateway, which every Worker asks over ACP (ADR 0132)",
  },
  {
    command: "version",
    route: "`--version` on `redskilled`, which every shipped binary answers off its build stamp",
  },
];

/**
 * Every verb the dev router still carries, named ONCE.
 *
 * The two lists above must partition this set exactly: a command in neither is a
 * verb nobody decided about, and a command in both is a decision made twice.
 */
export const DEV_COMMAND_VERBS: readonly string[] = [
  "run",
  "project",
  "monitor",
  "stop",
  "go",
  "manager",
  "dashboard",
  "audit-skills",
  "afk-output-shaping",
  "daily-review",
  "weekly-review",
  "reap",
  "orphan-branches",
  "path-brief",
  "red-doctor",
  "worktree",
  "redact-sweep",
  "relabel-sweep",
  "requeue",
  "retake",
  "review",
  "respond",
  "hitl-card",
  "triage",
  "codex-monitor-agent",
  "codex-statusline",
  "route-model-tier",
  "rsp-instructions",
  "statusline",
  "inject-development-workflow",
  "install-type-labels",
  "toon-bump",
  "toon-migrate",
  "reconcile-engine",
  "worker-gh",
  "version",
];

/**
 * The shipped skill trees the sweep walks.
 *
 * `plugins/*` is expanded at scan time, so a new plugin's skills inherit the rule
 * the moment they land. The generated skill mirrors under `packaging/pi` are
 * deliberately absent: they are copies, and counting a copy would report one
 * mention twice while fixing the copy would fix nothing.
 */
export const SKILL_TREE_ROOT = "plugins";

/** One place a shipped skill names a verb on the command line. */
export interface SkillNamedVerbSite {
  /** Repo-relative path, POSIX-separated. */
  readonly path: string;
  /** 1-based line. */
  readonly line: number;
  /** The verb that followed the binary. */
  readonly verb: string;
}

/**
 * A command is a LINE somebody pastes, so the binary and its verb are matched on
 * one line only.
 *
 * This is the whole discrimination, and it is deliberately the same one the bare
 * invocation sweep makes: naming the binary in prose (`` `<binary>` `` closed by
 * its own backtick, or followed by a `<placeholder>`) is documentation, while a
 * lowercase token after it on the same line is a verb an agent will run.
 */
function namedVerbPattern(): RegExp {
  const binary = DEV_CLI_BINARY.replace(/[^A-Za-z0-9_]/g, (char) => "\\" + char);
  return new RegExp(binary + "[ \\t]+([a-z][a-z0-9-]*)", "g");
}

/** Every verb a shipped skill names, with the file and line that names it. PURE input, filesystem read. */
export function collectSkillNamedVerbs(root: string): SkillNamedVerbSite[] {
  const sites: SkillNamedVerbSite[] = [];
  const pattern = namedVerbPattern();
  for (const path of skillMarkdownFiles(root)) {
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        sites.push({ path, line: index + 1, verb: match[1] as string });
      }
    });
  }
  return sites;
}

/** Every `.md` under every plugin's skill tree, repo-relative and POSIX-separated. */
export function skillMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const pluginsDir = join(root, SKILL_TREE_ROOT);
  let plugins: string[];
  try {
    plugins = readdirSync(pluginsDir);
  } catch {
    return files;
  }
  for (const plugin of plugins.sort()) {
    const skills = join(pluginsDir, plugin, "skills");
    try {
      if (!statSync(skills).isDirectory()) continue;
    } catch {
      continue;
    }
    collectMarkdown(root, skills, files);
  }
  return files.sort();
}

function collectMarkdown(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdown(root, absolute, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    out.push(posix(relative(root, absolute)));
  }
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
