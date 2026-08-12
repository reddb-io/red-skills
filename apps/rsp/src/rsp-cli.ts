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
  // Re-invoking this entry must keep the runtime flags it was started with
  // (e.g. `--import tsx` when running from source): `[execPath, argv[1]]`
  // alone re-runs a loader-dependent entry without its loader, and the inner
  // invocation dies with ERR_MODULE_NOT_FOUND instead of executing. For the
  // shipped bundle execArgv is empty, so this is byte-identical there.
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}
