import { parseRunnerFlag, detectRunner } from "../core/runner-detection.js";
import { runLegacy } from "../platform/legacy.js";

export interface RunOptions {
  args: string[];
  cwd?: string;
}

export async function runCommand(options: RunOptions): Promise<number> {
  const flag = parseRunnerFlag(options.args);
  const detection = detectRunner({ flag, scriptPath: process.argv[1] });
  if (!process.env.RED_AFK_TS_QUIET_BOOT) {
    process.stderr.write(`[afk-ts] runner: ${detection.runner} (detected via ${detection.method})\n`);
    process.stderr.write("[afk-ts] compatibility mode: delegating orchestration to scripts/afk.sh\n");
  }
  return runLegacy("afk", options.args, options.cwd);
}
