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
 *   pnpm --filter @redskills/opencode-host generate
 *   pnpm --filter @redskills/opencode-host generate -- --config ./.red/config.yaml --out ./dist/opencode
 *
 * Behaviour:
 *   - reads `<config>` (default `./.red/config.yaml`),
 *   - checks the ADR 0067 strict opt-in gate (`plugins.dev.enabled: true`),
 *   - builds the Slice 1 + Slice 2 plan for the named plugins
 *     (default: every plugin under `plugins/`),
 *   - writes the dist tree to `<out>` (default `./dist/opencode`).
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
  buildProviderBlock,
  isDevPluginEnabled,
  pickAuthPrecedence,
} from "./provider-block.js";
import { planEmit, writeEmit } from "./emit.js";
import { listPluginDirs } from "./plugin-discovery.js";

interface CliArgs {
  configPath: string;
  /** Slice 1: write the provider block to this file path. */
  outPath: string;
  /** Slice 2: write the dist tree under this directory. */
  outDir: string;
  pluginsRoot: string;
  showHelp: boolean;
  printJson: boolean;
  copySkills: boolean;
  pluginFilter: string[] | null;
  slice2: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = {
    configPath: "./.red/config.yaml",
    outPath: "./opencode.json",
    outDir: "./dist/opencode",
    pluginsRoot: "./plugins",
    showHelp: false,
    printJson: false,
    copySkills: false,
    pluginFilter: null,
    slice2: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      const next = argv[++i];
      if (typeof next !== "string" || next.length === 0) {
        process.stderr.write("opencode-host: --config requires a path\n");
        process.exit(2);
      }
      args.configPath = next;
    } else if (arg === "--out" || arg === "-o") {
      const next = argv[++i];
      if (typeof next !== "string" || next.length === 0) {
        process.stderr.write("opencode-host: --out requires a path\n");
        process.exit(2);
      }
      args.outPath = next;
    } else if (arg === "--out-dir" || arg === "-d") {
      const next = argv[++i];
      if (typeof next !== "string" || next.length === 0) {
        process.stderr.write("opencode-host: --out-dir requires a path\n");
        process.exit(2);
      }
      args.outDir = next;
    } else if (arg === "--plugins-root" || arg === "-p") {
      const next = argv[++i];
      if (typeof next !== "string" || next.length === 0) {
        process.stderr.write("opencode-host: --plugins-root requires a path\n");
        process.exit(2);
      }
      args.pluginsRoot = next;
    } else if (arg === "--plugin") {
      const next = argv[++i];
      if (typeof next !== "string" || next.length === 0) {
        process.stderr.write("opencode-host: --plugin requires a name\n");
        process.exit(2);
      }
      args.pluginFilter = [...(args.pluginFilter ?? []), next];
    } else if (arg === "--with-slice-2" || arg === "--slice-2") {
      args.slice2 = true;
    } else if (arg === "--copy") {
      args.copySkills = true;
    } else if (arg === "--help" || arg === "-h") {
      args.showHelp = true;
    } else if (arg === "--print") {
      args.printJson = true;
    } else {
      process.stderr.write(`opencode-host: unknown arg ${arg}\n`);
      process.exit(2);
    }
  }
  return args;
}

const HELP = `opencode-host generate — emit the opencode-host runtime tree

Slice 1: opencode.json (provider block) at <out>
Slice 2: dist tree at <out-dir>/<plugin>/{opencode.json, .opencode/...}

Usage:
  opencode-host generate [--config <path>] [--out <path>] [--out-dir <path>] [--plugins-root <path>] [--plugin <name>] [--copy] [--print] [--with-slice-2]
  opencode-host generate --help

Options:
  -c, --config <path>        path to .red/config.yaml (default: ./.red/config.yaml)
  -o, --out <path>           Slice 1: path to write opencode.json (default: ./opencode.json)
  -d, --out-dir <path>       Slice 2: dist root (default: ./dist/opencode)
  -p, --plugins-root <path>  path to the plugins/ tree (default: ./plugins)
      --plugin <name>        emit only this plugin (repeatable; Slice 2 only)
      --copy                 copy SKILL.md instead of symlinking
      --with-slice-2         also emit the Slice 2 dist tree (skills + hooks); off by default
  --print                    print Slice 1 JSON to stdout (Slice 2 not written)
  -h, --help                 show this help

Exit codes:
  0  wrote (or printed) successfully
  1  read/write failure or opt-in gate closed (plugins.dev.enabled: true missing)
  2  usage error

Notes:
  - The ADR 0067 strict opt-in gate applies: plugins.dev.enabled: true must be set.
  - Slice 1 (--out) is unaffected by --plugin/--no-slice-2; it is the standalone
    provider-block JSON file.
  - Planner errors (bad name, missing frontmatter) are reported on stderr but
    do NOT fail the build. The events the generator can map are emitted.
`;

function main(argv: ReadonlyArray<string>): void {
  const args = parseArgs(argv);
  if (args.showHelp) {
    process.stdout.write(HELP);
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
      "opencode-host: refusing to emit — plugins.dev.enabled is not true in .red/config.yaml (ADR 0067 strict opt-in). Run /setup-red-skills to enable the dev plugin.\n",
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
  // This is the Slice 1 contract; the Slice 2 dist tree reuses the same
  // provider block but writes it under <outDir>/<plugin>/opencode.json.
  const config = buildProviderBlock({ configText, env: process.env });
  const header = [
    "// generated by @redskills/opencode-host",
    `// version: ${buildVersion}`,
    "// slice: 1 (provider block only; skills/hooks land in slice 2 via --with-slice-2)",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
  ].join("\n");
  const slice1Rendered = header + JSON.stringify(config, null, 2) + "\n";

  if (args.printJson) {
    process.stdout.write(slice1Rendered);
    return;
  }

  // Slice 1: write <out> as a single JSON file (the Slice 1 contract).
  try {
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, slice1Rendered, "utf8");
  } catch (err) {
    process.stderr.write(
      `opencode-host: could not write ${args.outPath}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  if (!args.slice2) {
    process.stdout.write(
      `opencode-host: wrote ${args.outPath} (slice 1 only; provider=${active ?? "openrouter"} via precedence, model=${config.model})\n`,
    );
    return;
  }

  // Slice 2: write the dist tree under <outDir>/<plugin>/.
  const discovered = listPluginDirs(pluginsRootAbs);
  const plugins =
    args.pluginFilter && args.pluginFilter.length > 0
      ? discovered.filter((p) => args.pluginFilter!.includes(p.name)).map((p) => p.name)
      : discovered.map((p) => p.name);

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
