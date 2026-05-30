import { runLegacy } from "../platform/legacy.js";

export async function monitorCommand(args: string[], cwd = process.cwd()): Promise<number> {
  return runLegacy("monitor", args, cwd);
}
