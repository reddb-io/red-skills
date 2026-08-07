#!/usr/bin/env node
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { isStructuredUsageRenderable } from "./cli/args.js";
import { main } from "./cli/main.js";
import { renderSetupResult, renderStats } from "./cli/stats.js";
import { renderStructuredError } from "./structured-error.js";

export function isDirectExecution(
  moduleUrl: string,
  entrypoint: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!entrypoint) return false;
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;
  try {
    const modulePath = paths.resolve(fileURLToPath(moduleUrl, { windows }));
    const entryPath = paths.resolve(entrypoint);
    return windows
      ? modulePath.toLowerCase() === entryPath.toLowerCase()
      : modulePath === entryPath;
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().then((code) => process.exit(code), (err) => {
    if (isStructuredUsageRenderable(err)) {
      process.stdout.write(err.render());
      process.exit(2);
    }
    process.stdout.write(renderStructuredError({
      command: "rsp",
      category: "real-error",
      error: err instanceof Error ? err.message : String(err),
      help: "rsp --help",
    }));
    process.exit(1);
  });
}

export { main, renderSetupResult, renderStats };
