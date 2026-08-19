import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SETUP = "plugins/dev/skills/engineering/red-setup";

/** Prose wraps, so every assertion reads the doc with line breaks collapsed. */
async function readSetupDoc(name: string): Promise<string> {
  return (await readFile(join(ROOT, SETUP, name), "utf8")).replace(/\s+/g, " ");
}

/**
 * #3062: red-setup used to end on success while the session could not call a
 * single tool. A host registers MCP servers at plugin load, so a plugin enabled
 * in THIS session is installed and not loaded — and only the skill that just
 * provisioned it is positioned to say which of the two happened.
 */
describe("red-setup post-install session verification", () => {
  it("verifies the session before the recap and links the write contract", async () => {
    const skill = await readSetupDoc("SKILL.md");

    expect(skill).toContain("installed is not loaded");
    expect(skill).toContain("WRITE-CONTRACT.md#verify-the-session-sees-the-plugin");
    expect(skill).toContain("Never end on success while the session is blind");
    expect(skill).toContain("/reload-plugins");
  });

  it("distinguishes installed-and-loaded from installed-reload-needed", async () => {
    const contract = await readSetupDoc("WRITE-CONTRACT.md");

    expect(contract).toContain("## Verify the session sees the plugin");
    expect(contract).toContain("installed and loaded");
    expect(contract).toContain("installed, reload needed");
    expect(contract).toContain("registers MCP servers **at plugin load**");
    // The verdict is asked of the session, not re-read off the disk that was
    // just written — the disk is exactly what looks correct in this failure.
    expect(contract).toContain("Ask the session, not the disk");
    expect(contract).toContain("mcp__");
    // The cure is the operator's, and the declaration is not the thing to fix.
    expect(contract).toContain("Never perform the reload yourself");
    expect(contract).toContain("only the load is missing");
    expect(contract).toContain("--session-mcp");
  });

  it("carries the verdict into the closing recap", async () => {
    const contract = await readSetupDoc("WRITE-CONTRACT.md");

    const doneAt = contract.indexOf("## Done");
    expect(doneAt).toBeGreaterThan(-1);
    expect(contract.slice(doneAt)).toContain("installed, reload needed");
  });
});
