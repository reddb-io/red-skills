#!/usr/bin/env node
import { isStructuredUsageRenderable } from "./cli/args.js";
import { main } from "./cli/main.js";
import { renderSetupResult, renderStats } from "./cli/stats.js";
import { renderStructuredError } from "./structured-error.js";

if (import.meta.url === `file://${process.argv[1]}`) {
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
