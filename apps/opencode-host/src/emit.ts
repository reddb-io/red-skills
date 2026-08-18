/**
 * emit.ts — the Slice 1 + Slice 2 emit orchestration. Takes a list of
 * planned providers, skills, and hooks, and writes the dist tree:
 *
 *   dist/opencode/<plugin>/
 *   ├── opencode.json               ← Slice 1 (provider block)
 *   └── .opencode/
 *       ├── plugin/<event>.ts       ← Slice 2 (hook → event modules)
 *       └── skills/<name>/SKILL.md  ← Slice 2 (skill symlinks/copies)
 *
 * All file IO is concentrated here so the planner modules stay pure
 * and the CLI is a thin caller.
 */
import { mkdirSync, symlinkSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildProviderBlock, type OpencodeConfig } from "./provider-block.js";
import {
  planAllSkills,
  renameSkillFrontmatter,
  type PlanResult,
} from "./skills-to-opencode.js";
import { planPluginHooks, type HookPlan } from "./hooks-to-events.js";
import { planPluginMcp, type McpPlan, type McpEntry } from "./mcp-passthrough.js";
import { planPluginStatusline, type StatuslinePlan } from "./statusline.js";
import {
  applySemanticAuthority,
  resolveSemanticAuthority,
  type SemanticAuthority,
} from "./semantic-authority.js";

/** A single plugin's planned output. */
export interface PluginEmit {
  plugin: string;
  provider: OpencodeConfig;
  skills: PlanResult;
  hooks: HookPlan[];
  mcp: McpPlan[];
  /** MCP names left to the host's own LSP (ADR 0075; issue #3972). */
  deferredMcp: string[];
  statusline: StatuslinePlan[];
}

/** Top-level emit plan for one or more plugins. */
export interface EmitPlan {
  byPlugin: PluginEmit[];
  /** Who owns semantic navigation for the host this plan targets. */
  semanticAuthority: SemanticAuthority;
}

export interface EmitOptions {
  /** Absolute path to the `dist/opencode/` root. */
  outRoot: string;
  /** Absolute path to the `plugins/` directory in the source tree. */
  pluginsRoot: string;
  /** Plugin names to emit. */
  plugins: string[];
  /** Read by `buildProviderBlock` to pick the active provider + model. */
  configText: string;
  env: Readonly<Record<string, string | undefined>>;
  /** When true, copy `SKILL.md` instead of symlinking. Default false. */
  copySkills?: boolean;
  /** Generator version string (printed in the install manifest). */
  version: string;
  /** Who owns semantic navigation. Default: a bare opencode host (no native LSP). */
  semanticAuthority?: SemanticAuthority;
}

/**
 * Build the full emit plan in memory. No filesystem IO happens here;
 * `writeEmit` does the writes.
 */
export function planEmit(input: {
  pluginsRoot: string;
  plugins: string[];
  configText: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Default: a bare opencode host, which has no LSP of its own. */
  semanticAuthority?: SemanticAuthority;
}): EmitPlan {
  const semanticAuthority = input.semanticAuthority ?? resolveSemanticAuthority("opencode");
  const skillPlan = planAllSkills(input.pluginsRoot, input.plugins);
  const byPlugin: PluginEmit[] = input.plugins.map((plugin) => {
    const skills = skillPlan.find((s) => s.plugin === plugin)?.result ?? { plans: [], errors: [] };
    const hooks = planPluginHooks(input.pluginsRoot, plugin);
    // A host that answers navigation natively never receives the navigator
    // launcher, so nothing in the emitted tree can birth a second stack.
    const { plans: mcp, deferred: deferredMcp } = applySemanticAuthority(
      planPluginMcp(input.pluginsRoot, plugin),
      semanticAuthority,
    );
    const statusline = planPluginStatusline(input.pluginsRoot, plugin);
    const provider = buildProviderBlock({
      configText: input.configText,
      env: input.env,
    });
    return { plugin, provider, skills, hooks, mcp, deferredMcp, statusline };
  });
  return { byPlugin, semanticAuthority };
}

/**
 * Write the full plan to disk. Errors collected by the planners are
 * surfaced to stderr; an emit with planner errors is still written
 * when possible so a partial install is preferred to a non-zero exit
 * (the skills/hooks the user actually depends on still ship).
 */
export function writeEmit(plan: EmitPlan, options: EmitOptions): void {
  for (const entry of plan.byPlugin) {
    const { plugin, provider, skills, hooks, mcp, statusline } = entry;
    const pluginRoot = join(options.outRoot, plugin);
    mkdirSync(pluginRoot, { recursive: true });

    // 1. opencode.json (Slice 1 + Slice 3 MCP passthrough)
    const opencodeJson: Record<string, unknown> = { ...provider };
    if (mcp.length > 0) {
      opencodeJson.mcp = mcpToObject(mcp);
    }
    writeFileSync(
      join(pluginRoot, "opencode.json"),
      JSON.stringify(opencodeJson, null, 2) + "\n",
      "utf8",
    );

    // 2. skill symlinks/copies
    for (const sp of skills.plans) {
      const target = join(pluginRoot, ".opencode", sp.target);
      mkdirSync(dirname(target), { recursive: true });
      if (sp.renamedFrom) {
        // A collision-renamed skill cannot be a symlink: opencode reads the
        // name from the frontmatter, so the copy carries the new one.
        writeFileSync(target, renameSkillFrontmatter(readFileSync(sp.source, "utf8"), sp.name), "utf8");
      } else if (options.copySkills) {
        copyFileSync(sp.source, target);
      } else {
        const rel = relative(dirname(target), sp.source);
        const portable = !rel.startsWith("..") || rel.split("/").filter((s) => s === "..").length <= 4;
        const linkTarget = portable ? rel : sp.source;
        try {
          symlinkSync(linkTarget, target);
        } catch {
          copyFileSync(sp.source, target);
        }
      }
    }

    // 3. hook → event modules
    for (const hp of hooks) {
      const target = join(pluginRoot, ".opencode", hp.target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, hp.source, "utf8");
    }

    // 4. Slice 4: statusline + toasts (only the dev plugin today)
    for (const sp of statusline) {
      const target = join(pluginRoot, ".opencode", sp.target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, sp.source, "utf8");
    }
  }
}

/** Reduce a McpPlan[] to the opencode `mcp:` shape
 *  (`{ <name>: <entry> }`). */
function mcpToObject(plans: McpPlan[]): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  for (const p of plans) {
    out[p.name] = p.entry;
  }
  return out;
}
