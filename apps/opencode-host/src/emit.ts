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
import { mkdirSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildProviderBlock, type OpencodeConfig } from "./provider-block.js";
import {
  planAllSkills,
  type PlanResult,
} from "./skills-to-opencode.js";
import { planPluginHooks, type HookPlan } from "./hooks-to-events.js";
import { planPluginMcp, type McpPlan, type McpEntry } from "./mcp-passthrough.js";

/** A single plugin's planned output. */
export interface PluginEmit {
  plugin: string;
  provider: OpencodeConfig;
  skills: PlanResult;
  hooks: HookPlan[];
  mcp: McpPlan[];
}

/** Top-level emit plan for one or more plugins. */
export interface EmitPlan {
  byPlugin: PluginEmit[];
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
}): EmitPlan {
  const skillPlan = planAllSkills(input.pluginsRoot, input.plugins);
  const byPlugin: PluginEmit[] = input.plugins.map((plugin) => {
    const skills = skillPlan.find((s) => s.plugin === plugin)?.result ?? { plans: [], errors: [] };
    const hooks = planPluginHooks(input.pluginsRoot, plugin);
    const mcp = planPluginMcp(input.pluginsRoot, plugin);
    const provider = buildProviderBlock({
      configText: input.configText,
      env: input.env,
    });
    return { plugin, provider, skills, hooks, mcp };
  });
  return { byPlugin };
}

/**
 * Write the full plan to disk. Errors collected by the planners are
 * surfaced to stderr; an emit with planner errors is still written
 * when possible so a partial install is preferred to a non-zero exit
 * (the skills/hooks the user actually depends on still ship).
 */
export function writeEmit(plan: EmitPlan, options: EmitOptions): void {
  for (const entry of plan.byPlugin) {
    const { plugin, provider, skills, hooks, mcp } = entry;
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
      if (options.copySkills) {
        copyFileSync(sp.source, target);
      } else {
        // Prefer a relative symlink so the dist tree is portable
        // (works after a `cp -r` or a release-asset download). When
        // the relative path would escape the dist root — e.g. the
        // source lives in a different filesystem or far enough that
        // `relative()` returns a path starting with `../../../../../` —
        // fall back to an absolute symlink. An absolute symlink still
        // works on the user's machine; it just stops being portable.
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
