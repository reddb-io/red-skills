import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInteractive } from "./command.js";

export type LegacyCommand = "afk" | "monitor" | "supervisor" | "once" | "hooks" | "statusline";

const scriptNames: Record<LegacyCommand, string> = {
  afk: "afk.sh",
  monitor: "monitor.sh",
  supervisor: "supervisor.sh",
  once: "once.sh",
  hooks: "hooks.sh",
  statusline: "statusline.sh",
};

export function skillDirFromModule(metaUrl = import.meta.url): string {
  let cursor = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cursor, "scripts", "afk.sh"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error("could not locate AFK skill directory from module path");
}

export function legacyScriptPath(command: LegacyCommand, skillDir = skillDirFromModule()): string {
  return join(skillDir, "scripts", scriptNames[command]);
}

export async function runLegacy(command: LegacyCommand, args: string[], cwd = process.cwd()): Promise<number> {
  const script = legacyScriptPath(command);
  const result = await runInteractive("bash", [script, ...args], { cwd, env: process.env });
  if (result.signal) return 128;
  return result.code ?? 1;
}
