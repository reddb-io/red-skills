import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");

describe("Castle proxy and resident packaging", () => {
  it("stages both matching-version npm artifacts", async () => {
    const prepare = await read("packaging/npm/scripts/prepare.mjs");
    expect(prepare).toContain('dest: "redskilled-mcp.bundle.min.mjs"');
    expect(prepare).toContain('dest: "castle-resident.bundle.min.mjs"');
  });

  it("checks both artifacts in the npm tarball and release backup", async () => {
    const workflow = await read(".github/workflows/red-publish.yml");
    for (const artifact of [
      "package/dist/redskilled-mcp.bundle.min.mjs",
      "package/dist/castle-resident.bundle.min.mjs",
      "dist/redskilled-mcp.bundle.min.mjs",
      "dist/castle-resident.bundle.min.mjs",
    ]) {
      expect(workflow, artifact).toContain(artifact);
    }
  });

  it("requires both artifacts before taking the source-checkout fallback", async () => {
    const launcher = await read("plugins/dev/hooks/redskilled-mcp.sh");
    expect(launcher).toContain('dist/redskilled-mcp.bundle.min.mjs');
    expect(launcher).toContain('dist/castle-resident.bundle.min.mjs');
    expect(launcher).toContain("could not locate matching redskilled-mcp and castle-resident bundles");
  });
});
