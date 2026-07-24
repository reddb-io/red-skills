import { existsSync } from "node:fs";
import { join } from "node:path";

function isRspOnPath(): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "rsp"))) return true;
  }
  return false;
}

export function resolveRspInvocationPrefix(): string[] {
  if (isRspOnPath()) return ["rsp"];
  return [process.execPath, process.argv[1]!];
}
