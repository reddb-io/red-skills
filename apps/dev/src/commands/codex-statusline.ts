import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_STATUSLINE_RECOMMENDED,
  ensureCodexTaskProgress,
  formatCodexStatusLine,
  inspectCodexStatuslineConfig,
  type CodexStatuslineInspection,
} from "../core/codex-statusline.js";

export interface CodexStatuslineCommandOptions {
  configPath?: string;
  json?: boolean;
  fix?: boolean;
}

function parseArgs(args: readonly string[]): CodexStatuslineCommandOptions {
  const out: CodexStatuslineCommandOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--fix") {
      out.fix = true;
    } else if (arg === "--config") {
      const value = args[++i];
      if (!value) throw new Error("codex-statusline --config requires a path");
      out.configPath = value;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else {
      throw new Error(`unknown codex-statusline argument '${arg}'`);
    }
  }
  return out;
}

function defaultConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.redskills.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function statusWord(inspection: CodexStatuslineInspection): "ok" | "warn" {
  return inspection.problem === null ? "ok" : "warn";
}

function renderPlain(path: string, inspection: CodexStatuslineInspection, changed: boolean): string {
  const lines = [
    `codex-statusline: ${statusWord(inspection)}`,
    `config: ${path}`,
  ];
  if (changed) lines.push("updated: added task-progress to tui.status_line");
  if (inspection.statusLine !== null) {
    lines.push(`current: ${formatCodexStatusLine(inspection.statusLine)}`);
  } else {
    lines.push("current: <unset>");
  }
  lines.push(`recommended: ${formatCodexStatusLine(CODEX_STATUSLINE_RECOMMENDED)}`);
  if (inspection.parseError) lines.push(`parse-error: ${inspection.parseError}`);
  if (inspection.problem === "hidden") {
    lines.push("note: status_line is [], so the Codex footer is intentionally hidden.");
  } else if (inspection.problem === "missing-task-progress") {
    lines.push("note: task-progress is missing, so Codex cannot show native task/subagent progress in the footer.");
    lines.push("fix: afk codex-statusline --fix");
  } else if (inspection.problem === "missing-tui" || inspection.problem === "missing-status-line") {
    lines.push("note: Codex will use its built-in default footer, which does not include task-progress.");
    lines.push("fix: afk codex-statusline --fix");
  }
  lines.push(
    "boundary: Codex supports built-in footer IDs only; read rich AFK Worker state from redskilled `status {scope: worker}` (no-MCP fallback: /afk monitor).",
  );
  lines.push("opencode: AFK API-auth runner only; no interactive host footer/plugin UI.");
  return `${lines.join("\n")}\n`;
}

export async function codexStatuslineCommand(
  args: string[],
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const options = parseArgs(args);
  const path = options.configPath ?? defaultConfigPath();

  if (!existsSync(path)) {
    const payload = {
      status: "warn",
      config: path,
      exists: false,
      recommended: CODEX_STATUSLINE_RECOMMENDED,
    };
    stdout.write(options.json ? `${JSON.stringify(payload)}\n` : `codex-statusline: warn\nconfig: ${path}\ncurrent: <missing file>\nrecommended: ${formatCodexStatusLine(CODEX_STATUSLINE_RECOMMENDED)}\nfix: create ${path} or run Codex once, then afk codex-statusline --fix\n`);
    return 0;
  }

  const before = readFileSync(path, "utf8");
  let changed = false;
  let text = before;
  if (options.fix) {
    text = ensureCodexTaskProgress(before);
    changed = text !== before;
    if (changed) writeAtomic(path, text);
  }
  const inspection = inspectCodexStatuslineConfig(text);

  if (options.json) {
    stdout.write(`${JSON.stringify({
      status: statusWord(inspection),
      config: path,
      changed,
      ...inspection,
      recommended: CODEX_STATUSLINE_RECOMMENDED,
    })}\n`);
    return 0;
  }

  stdout.write(renderPlain(path, inspection, changed));
  return 0;
}
