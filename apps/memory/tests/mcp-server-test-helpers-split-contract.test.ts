import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const maxLines = 1_200;
const helperFiles = [
  "mcp-server-test-helpers.ts",
  "mcp-server-test-fixtures.ts",
  "mcp-server-registry-test-helpers.ts",
  "mcp-server-registry-readiness-test-helpers.ts",
];

describe("MCP server test helper split contract", () => {
  it("keeps the stable helper and its split modules within the line budget", async () => {
    for (const file of helperFiles) {
      const source = await readFile(join(__dirname, file), "utf8");
      expect(source.split(/\r?\n/).length, file).toBeLessThanOrEqual(maxLines);
    }
  });

  it("keeps the original runtime exports on the stable helper path", async () => {
    const helper = await import("./mcp-server-test-helpers.js");

    expect(Object.keys(helper).sort()).toEqual([
      "TIMEOUT",
      "cleanupMcpServerTest",
      "connect",
      "pluginRoot",
      "roots",
      "runRegistryBackedReadinessAndTrustTools",
      "seedConfiguredStore",
      "seedConflictStore",
      "seedStore",
      "seedWritableStore",
      "toolText",
    ]);
  });
});
