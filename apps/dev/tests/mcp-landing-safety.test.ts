import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("MCP land_branch safety parity", () => {
  it("waits for routed CI and requires validation on the integrated tree", async () => {
    const source = await readFile(join(ROOT, "apps/dev/src/mcp/handlers.ts"), "utf8");
    const handler = source.slice(source.indexOf("async landBranch(input)"), source.indexOf("async cascadeStatus(input)"));

    expect(handler).toContain('createDevGithubMergeRead(root, "mcp-land-branch")');
    expect(handler).toContain("ciAwait:");
    expect(handler).toContain("postMergeGate:");
    expect(handler).toContain('worktreeKind: "checkout"');
    expect(handler).toContain("requirePostMergeValidation: true");
    expect(handler.indexOf("postMergeGate:")).toBeLessThan(handler.indexOf("requirePostMergeValidation: true"));
  });
});
