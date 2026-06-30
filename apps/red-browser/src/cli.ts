#!/usr/bin/env node
import { annotateCommand } from "./commands/annotate.js";

const [, , cmd, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case "annotate":
      await annotateCommand(rest);
      break;
    default:
      process.stderr.write(
        "Usage: red-browser annotate <html-file> [--timeout <ms>] [--skip-audit]\n",
      );
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
