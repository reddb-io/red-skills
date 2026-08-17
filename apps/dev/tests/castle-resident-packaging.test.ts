// The Castle resident used to ship beside the MCP proxy and later as a role of
// the same bundle. The stdio surface is now only an ACP adapter: redskilled owns
// Project state, so no resident artifact or hidden resident role remains.
//
// What still needs pinning is that the ONE artifact reaches every layout, which
// is what these three surfaces answer for.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");
const ARTIFACT = "redskilled-mcp.bundle.min.mjs";

describe("MCP-to-ACP adapter packaging", () => {
  it("stages the one npm artifact", async () => {
    const prepare = await read("packaging/npm/scripts/prepare.mjs");
    expect(prepare).toContain(`dest: "${ARTIFACT}"`);
    expect(prepare, "the retired sibling is still staged").not.toContain("castle-resident.bundle.min.mjs");
  });

  it("checks it in the npm tarball and the release backup", async () => {
    const workflow = await read(".github/workflows/red-publish.yml");
    // The publish-time presence guard moved out of the workflow YAML into the
    // boundary script (#3957), so assert it WHERE IT LIVES. The script derives
    // the list from `prepare.mjs`, which is why staging the artifact is enough
    // to be guarded — and why a hand-edited list cannot silently drop it again.
    const boundaries = await read("scripts/check-npm-tarball-boundaries.mjs");
    expect(boundaries).toContain("stagedCoreBundles");
    expect(boundaries).toContain("package/dist/");
    expect(workflow).toContain("check-npm-tarball-boundaries.mjs");
    expect(workflow, "the retired sibling is still checked").not.toContain("castle-resident.bundle.min.mjs");
  });

  it("requires it before taking the source-checkout fallback", async () => {
    const launcher = await read("plugins/dev/hooks/redskilled-mcp.sh");
    expect(launcher).toContain(`dist/${ARTIFACT}`);
    expect(launcher, "the retired sibling still gates the fallback").not.toContain(
      "castle-resident.bundle.min.mjs",
    );
  });

  it("connects to redskilled through ACP and owns no Castle resident role", async () => {
    const source = await read("apps/dev/src/mcp-server.ts");
    expect(source).toContain("connectRedskillsProjectAcp");
    expect(source).toContain("invokeProjectMcp(await project(), method, input)");
    expect(source).toContain("resolveMcpProjectRoot(server.server");
    expect(source).not.toContain("__castle-resident");
    expect(source).not.toContain("CastleResidentClient");
    expect(source).not.toContain("resolveCastleResidentBundle");
  });
});
