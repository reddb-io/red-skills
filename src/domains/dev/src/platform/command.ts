import { spawn, type SpawnOptions } from "node:child_process";

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function runInteractive(command: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}
