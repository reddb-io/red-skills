// The Castle resident used to ship as a SECOND bundle beside the MCP proxy,
// resolved as a sibling file, and this suite existed to make the pair travel
// together: every assertion said "both". It is a ROLE of the one bundle now
// (`__castle-resident`), so there is no half to lose — one artifact carries the
// proxy and the resident, and the version can never skew against itself.
//
// What still needs pinning is that the ONE artifact reaches every layout, which
// is what these three surfaces answer for.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");
const ARTIFACT = "redskilled-mcp.bundle.min.mjs";

describe("Castle proxy and resident packaging", () => {
  it("stages the one npm artifact", async () => {
    const prepare = await read("packaging/npm/scripts/prepare.mjs");
    expect(prepare).toContain(`dest: "${ARTIFACT}"`);
    expect(prepare, "the retired sibling is still staged").not.toContain("castle-resident.bundle.min.mjs");
  });

  it("checks it in the npm tarball and the release backup", async () => {
    const workflow = await read(".github/workflows/red-publish.yml");
    expect(workflow).toContain(`package/dist/${ARTIFACT}`);
    expect(workflow).toContain(`dist/${ARTIFACT}`);
    expect(workflow, "the retired sibling is still checked").not.toContain("castle-resident.bundle.min.mjs");
  });

  it("requires it before taking the source-checkout fallback", async () => {
    const launcher = await read("plugins/dev/hooks/redskilled-mcp.sh");
    expect(launcher).toContain(`dist/${ARTIFACT}`);
    expect(launcher, "the retired sibling still gates the fallback").not.toContain(
      "castle-resident.bundle.min.mjs",
    );
  });

  it("spawns the resident from the running bundle, never from a sibling path", async () => {
    const source = await read("apps/dev/src/mcp-server.ts");
    // The spawn names THIS file plus the role; a sibling resolver would be the
    // pairing invariant coming back by another door.
    expect(source).toContain('serverArgs: [fileURLToPath(import.meta.url), "__castle-resident"]');
    expect(source).not.toContain("resolveCastleResidentBundle");
  });
});
