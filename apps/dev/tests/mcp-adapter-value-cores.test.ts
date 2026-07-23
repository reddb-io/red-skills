import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0120 rule 2: the MCP adapter operations call value-returning cores directly
// and TOON-encode once at the transport boundary. They must NOT capture a command
// handler's printed stream and re-parse it, and the print-and-exit command layer
// must not be reachable from the adapter.

const here = dirname(fileURLToPath(import.meta.url));
const adapterTs = resolve(here, "../src/mcp-adapter.ts");

describe("mcp-adapter value cores", () => {
  const source = readFileSync(adapterTs, "utf8");

  it("does not round-trip command output through a captured stream", () => {
    expect(source).not.toContain("captureStream");
    expect(source).not.toContain("parsedCommandOutput");
  });

  it("does not reach the print-and-exit command layer", () => {
    expect(source).not.toContain("retakeCommand(");
    expect(source).not.toContain("triageCommand(");
    expect(source).not.toContain("respondCommand(");
    expect(source).not.toContain("activityReviewCommand(");
    expect(source).not.toContain("stopCommand(");
  });
});
