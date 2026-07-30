/**
 * generate.ts — the build-time CLI that emits the opencode-host
 * runtime tree for a project.
 *
 * Slice 1: emits `opencode.json` (provider block).
 * Slice 2: emits `.opencode/skills/<name>/SKILL.md` (symlinks/copies)
 *           and `.opencode/plugin/<event>.ts` (hook → event modules).
 * Slice 3-5: MCP passthrough, agents → subagents, remote install.
 *
 * Usage (local-dev path):
 *   pnpm --filter @reddb-io/red-skills generate
 *   pnpm --filter @reddb-io/red-skills generate -- --config ./.red/config.yaml --out ./dist/opencode
 *
 * Arguments are routed and parsed by the shared contract (ADR 0114); the
 * accepted surface is declared in `cli-args.ts`.
 *
 * Behaviour:
 *   - reads `<config>` (default `./.red/config.yaml`),
 *   - checks the ADR 0067 strict opt-in gate (`plugins.dev.enabled: true`),
 *   - builds the Slice 1 + Slice 2 plan for the named plugins
 *     (default: every plugin under `plugins/`),
 *   - writes the dist tree to `<out-dir>` (default `./dist/opencode`).
 *
 * Exit codes:
 *   0  — wrote the tree (errors may have been logged; check stderr).
 *   1  — read or write failure, or the opt-in gate is closed.
 *   2  — usage error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import {
  isVersionRequest,
  OpencodeHostUsageError,
  parseOpencodeHostArgs,
  renderHelp,
  type OpencodeHostArgs,
} from "./cli-args.js";
import {
  buildProviderBlock,
  isDevPluginEnabled,
  pickAuthPrecedence,
} from "./provider-block.js";
import { planEmit, writeEmit } from "./emit.js";
import { listPluginDirs } from "./plugin-discovery.js";
import { planPluginMcp, type McpPlan, type McpEntry } from "./mcp-passthrough.js";

/** Collect MCP plans from every plugin for the standalone Slice 1
 *  `opencode.json` (the user wants one `mcp:` block that includes
 *  all installed plugins, not one per plugin). The Slice 2 dist
 *  tree emits the per-plugin split; the standalone file merges. */
function collectMcpForStandalone(
  pluginsRoot: string,
  plugins: string[],
): { mcps: McpPlan[]; warnings: string[] } {
  const mcps: McpPlan[] = [];
  const warnings: string[] = [];
  for (const p of plugins) {
    for (const plan of planPluginMcp(pluginsRoot, p)) {
      mcps.push(plan);
      for (const w of plan.warnings) warnings.push(`[${p}] ${w}`);
    }
  }
  // Dedup by MCP name (memory and brain both ship `red-ui`; the
  // first one wins, matching the Slice 1+2 dist tree behaviour).
  const seen = new Set<string>();
  const deduped = mcps.filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
  return { mcps: deduped, warnings };
}

function mcpPlansToObject(plans: McpPlan[]): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  for (const p of plans) out[p.name] = p.entry;
  return out;
}

/** Print the build version — the answer this binary owes before anything else. */
function writeVersion(asJson: boolean): void {
  const info = readBuildInfo("opencode-host");
  process.stdout.write(asJson ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
}

function main(argv: ReadonlyArray<string>): void {
  // Answered before config, the opt-in gate, or any plugin discovery: "which
  // build is this?" must stay answerable in exactly the situation you need to
  // ask it — an unconfigured directory, a closed gate, an empty plugins tree.
  if (isVersionRequest(argv)) {
    writeVersion(argv.includes("--json"));
    return;
  }

  let args: OpencodeHostArgs;
  try {
    args = parseOpencodeHostArgs(argv);
  } catch (err) {
    if (err instanceof OpencodeHostUsageError) {
      process.stderr.write(`opencode-host: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (args.showVersion) {
    writeVersion(args.versionJson);
    return;
  }
  if (args.showHelp) {
    process.stdout.write(renderHelp());
    return;
  }

  const info = readBuildInfo("opencode-host");
  const buildVersion = renderVersion(info);

  const configAbs = resolve(args.configPath);
  const pluginsRootAbs = resolve(args.pluginsRoot);
  const outAbs = resolve(args.outPath);
  const outDirAbs = resolve(args.outDir);

  let configText: string;
  try {
    configText = readFileSync(configAbs, "utf8");
  } catch (err) {
    process.stderr.write(
      `opencode-host: could not read config at ${configAbs}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  if (!isDevPluginEnabled(configText)) {
    process.stderr.write(
      "opencode-host: refusing to emit — plugins.dev.enabled is not true in .red/config.yaml (ADR 0067 strict opt-in). Run /red-setup to enable the dev plugin.\n",
    );
    process.exit(1);
  }

  const active = pickAuthPrecedence(process.env);
  if (active === undefined) {
    process.stderr.write(
      "opencode-host: no auth env-var set (OPENAI_API_KEY / MINIMAX_API_KEY / OPENROUTER_API_KEY). Run `/connect` inside opencode to pick a provider, or export one of the env vars.\n",
    );
  }

  // Slice 1: write the provider block to <out> as a standalone JSON file.
  // Slice 3 (MCP passthrough) is now part of the Slice 1 contract: a
  // user who runs the standalone Slice 1 wants a complete
  // opencode.json (provider + the MCP servers their installed
  // plugins ship), not just the provider block. The Slice 2 dist
  // tree reuses the same provider+MCP shape but writes it under
  // <outDir>/<plugin>/opencode.json.
  const config = buildProviderBlock({ configText, env: process.env });
  // Discover plugins first so the standalone file can include every
  // MCP the user has installed. (Slice 2 also calls listPluginDirs
  // — the call is cheap, just a stat per directory.)
  const discoveredForMcp = listPluginDirs(pluginsRootAbs);
  const standaloneMcp = collectMcpForStandalone(pluginsRootAbs, discoveredForMcp.map((d) => d.name));
  const standaloneJson: Record<string, unknown> = { ...config };
  if (standaloneMcp.mcps.length > 0) {
    standaloneJson.mcp = mcpPlansToObject(standaloneMcp.mcps);
  }
  const header = [
    "// generated by @reddb-io/red-skills",
    `// version: ${buildVersion}`,
    standaloneMcp.mcps.length > 0
      ? `// slice: 1+3 (provider block + ${standaloneMcp.mcps.length} MCP server(s))`
      : "// slice: 1 (provider block only)",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
  ].join("\n");
  const slice1Rendered = header + JSON.stringify(standaloneJson, null, 2) + "\n";

  if (args.printJson) {
    process.stdout.write(slice1Rendered);
    return;
  }

  // Slice 1 (+ Slice 3 MCP passthrough): write <out> as a single JSON
  // file. The Slice 1 contract is "the opencode.json at the user's
  // config root"; Slice 3 ships the MCP servers that come with the
  // installed plugins.
  try {
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, slice1Rendered, "utf8");
  } catch (err) {
    process.stderr.write(
      `opencode-host: could not write ${args.outPath}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // Surface Slice 3 warnings on stderr (the Slice 1 build is
  // warn-and-continue: a missing script path emits a `sh -c` fallback
  // and a warning, not a hard error).
  for (const w of standaloneMcp.warnings) {
    process.stderr.write(`opencode-host: mcp warning — ${w}\n`);
  }

  if (!args.slice2) {
    process.stdout.write(
      `opencode-host: wrote ${args.outPath} (slice 1+3; provider=${active ?? "openrouter"} via precedence, model=${config.model}, mcps=${standaloneMcp.mcps.length})\n`,
    );
    return;
  }

  // Slice 2: write the dist tree under <outDir>/<plugin>/.
  const plugins =
    args.pluginFilter && args.pluginFilter.length > 0
      ? discoveredForMcp.filter((p) => args.pluginFilter!.includes(p.name)).map((p) => p.name)
      : discoveredForMcp.map((p) => p.name);

  if (plugins.length === 0) {
    process.stderr.write(
      `opencode-host: no plugins discovered under ${pluginsRootAbs} (expected directories like dev/, memory/, brain/)\n`,
    );
    process.exit(1);
  }

  const plan = planEmit({
    pluginsRoot: pluginsRootAbs,
    plugins,
    configText,
    env: process.env,
  });

  try {
    mkdirSync(outDirAbs, { recursive: true });
    writeEmit(plan, {
      outRoot: outDirAbs,
      pluginsRoot: pluginsRootAbs,
      plugins,
      configText,
      env: process.env,
      copySkills: args.copySkills,
      version: buildVersion,
    });
  } catch (err) {
    process.stderr.write(
      `opencode-host: could not write ${outAbs}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // Report planner warnings to stderr; the emit still succeeded.
  let warnings = 0;
  for (const pe of plan.byPlugin) {
    for (const e of pe.skills.errors) {
      process.stderr.write(`opencode-host: skill error in ${pe.plugin}: ${e.message}\n`);
      warnings++;
    }
    for (const hp of pe.hooks) {
      for (const w of hp.warnings) {
        process.stderr.write(`opencode-host: hook warning in ${pe.plugin}: ${w}\n`);
        warnings++;
      }
    }
  }

  process.stdout.write(
    `opencode-host: wrote ${args.outPath} (slice 1 provider block) + ${outDirAbs} (slice 2 dist tree; plugins=${plugins.length}, skills=${plan.byPlugin.reduce((a, p) => a + p.skills.plans.length, 0)}, hooks=${plan.byPlugin.reduce((a, p) => a + p.hooks.length, 0)}, warnings=${warnings}, provider=${active ?? "openrouter"} via precedence)\n`,
  );
}

main(process.argv.slice(2));
