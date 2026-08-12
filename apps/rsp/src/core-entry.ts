import { isStructuredUsageRenderable } from "./cli/args.js";
import { main } from "./cli/main.js";
import { renderStructuredError } from "./structured-error.js";
export { renderStructuredBoundary } from "./structured-boundary.js";
export { renderAutomaticCommandOutput } from "./automatic-output-policy.js";

export { main };

export function renderCliFailure(err: unknown): { output: Buffer; status: number } {
  if (isStructuredUsageRenderable(err)) return { output: err.render(), status: 2 };
  return {
    output: renderStructuredError({
      command: "rsp",
      category: "real-error",
      error: err instanceof Error ? err.message : String(err),
      help: "rsp --help",
    }),
    status: 1,
  };
}
