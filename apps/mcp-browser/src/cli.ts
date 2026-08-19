#!/usr/bin/env node
import { annotateCommand } from "./commands/annotate.js";
import { snapshotCommand } from "./commands/snapshot.js";

const [, , cmd, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case "annotate":
      await annotateCommand(rest);
      break;
    case "snapshot":
      await snapshotCommand(rest);
      break;
    default:
      process.stderr.write(
        "Usage:\n" +
          "  red-browser annotate <html-file> [--timeout <ms>] [--skip-audit]\n" +
          "  red-browser snapshot [--cdp <url>] [--target <url-substring>]\n",
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
