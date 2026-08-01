/**
 * `red-skills-dev install-type-labels [label…]` — the installer path for ticket
 * TYPE labels (#3013).
 *
 * `/red-setup`'s label provisioning and `/wayfinder`'s own label creation both
 * come here instead of running bare `gh label create`, because a HUMAN-ONLY
 * type label is only half a protection: without its `afk.labels.hitl_types`
 * entry the repo LOOKS protected while every unblocked decision Ticket goes to
 * the autonomous queue. One command installs both halves or neither.
 */
import { readFile, writeFile } from "node:fs/promises";
import { encode as encodeToon } from "@reddb-io/toon";
import { configFile } from "@reddb-io/shared/red-paths.js";
import { ensureLabel, type GhContext } from "../runtime/gh.js";
import { resolveRepoContext } from "../runtime/wire.js";
import {
  hitlTypeLabelsAmong,
  installTypeLabels,
  WAYFINDER_TYPE_LABELS,
  type TypeLabelInstallReceipt,
} from "../core/hitl-type-declaration.js";

/** The label's own description says which lane its Tickets resolve in, so an
 * operator reading the tracker's label list sees the routing too. */
function describe(label: string): { color: string; description: string } {
  return hitlTypeLabelsAmong([label]).length > 0
    ? { color: "D93F0B", description: "HUMAN-ONLY ticket type; resolves with a human, never in the autonomous queue" }
    : { color: "0E8A16", description: "Ticket type; agent-resolvable" };
}

export const INSTALL_TYPE_LABELS_USAGE = `Usage: red-skills-dev install-type-labels [label…] [options]

Installs each ticket TYPE label on the issue tracker AND declares the HUMAN-ONLY
ones in .red/config.yaml (plugins.dev.afk.labels.hitl_types). With no label
arguments the shipped /wayfinder vocabulary is installed:
  ${WAYFINDER_TYPE_LABELS.join(", ")}

Options:
  --root <dir>   repository to install into (default: cwd)
  --json         emit the receipt as TOON instead of prose
`;

interface InstallTypeLabelsFlags {
  labels: string[];
  json: boolean;
  root: string;
}

function parseFlags(args: readonly string[], cwd: string): InstallTypeLabelsFlags {
  const flags: InstallTypeLabelsFlags = { labels: [], json: false, root: cwd };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[++i];
      if (!value) throw new Error("--root requires a value");
      flags.root = value;
      continue;
    }
    if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown install-type-labels argument: ${arg}`);
    flags.labels.push(arg);
  }
  if (flags.labels.length === 0) flags.labels = [...WAYFINDER_TYPE_LABELS];
  return flags;
}

function renderHuman(receipt: TypeLabelInstallReceipt): string {
  if (receipt.refusal) return `install-type-labels refused: ${receipt.refusal}\n`;
  const lines = [
    `installed labels: ${receipt.installed.join(", ")}`,
    receipt.declared.length > 0
      ? `declared HUMAN-ONLY types: ${receipt.declared.join(", ")}`
      : "declared HUMAN-ONLY types: none (already declared or none installed)",
  ];
  if (receipt.alreadyDeclared.length > 0) {
    lines.push(`already declared: ${receipt.alreadyDeclared.join(", ")}`);
  }
  lines.push(`.red/config.yaml: ${receipt.configChanged ? "updated" : "unchanged"}`);
  return `${lines.join("\n")}\n`;
}

export async function installTypeLabelsCommand(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  try {
    const flags = parseFlags(args, cwd);
    const ctx = await resolveRepoContext(flags.root);
    const configPath = configFile(ctx.root);
    const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

    const receipt = await installTypeLabels(flags.labels, {
      ensureLabel: (name) => ensureLabel(ghCtx, name, describe(name)),
      readConfig: async () => {
        try {
          return await readFile(configPath, "utf8");
        } catch {
          return null;
        }
      },
      writeConfig: async (text) => {
        await writeFile(configPath, text, "utf8");
      },
    });

    process.stdout.write(
      flags.json
        ? encodeToon({
            installed: [...receipt.installed],
            declared: [...receipt.declared],
            alreadyDeclared: [...receipt.alreadyDeclared],
            configChanged: receipt.configChanged,
            refusal: receipt.refusal ?? "",
          })
        : renderHuman(receipt),
    );
    return receipt.refusal ? 1 : 0;
  } catch (error) {
    process.stderr.write(`[install-type-labels] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
