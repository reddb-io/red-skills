import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** Prose wraps, so every assertion reads the doc with line breaks collapsed. */
async function readDoc(path: string): Promise<string> {
  return (await readFile(join(ROOT, path), "utf8")).replace(/\s+/g, " ");
}

const SETUP = "plugins/dev/skills/engineering/red-setup";
const STATUSLINE = "plugins/dev/skills/engineering/red-statusline";
const PI_SETUP = "packaging/pi/dev/skills/engineering/red-setup";
const PI_STATUSLINE = "packaging/pi/dev/skills/engineering/red-statusline";

/**
 * #3075: Claude Code loads `.claude/settings.json` at session start, so a
 * `statusLine` written mid-session is on disk and absent from the running
 * process. Every check an operator runs then passes — valid JSON, key present,
 * command renders — and the line still stays blank until they restart. Only the
 * skill that just wrote the key is positioned to say so.
 */
describe("statusline write-vs-load restart guidance (#3075)", () => {
  it("makes the write contract report the restart, and only on the write path", async () => {
    const contract = await readDoc(`${SETUP}/WRITE-CONTRACT.md`);

    expect(contract).toContain("written, restart needed");
    expect(contract).toContain("reads `.claude/settings.json` at **session start**");
    // The cure is a new session, and the neighbouring cure is not it.
    expect(contract).toContain("reloads plugins, not project settings");
    // A skipped write changed nothing, so it has nothing to announce.
    expect(contract).toContain("no restart to ask for");
  });

  it("carries the statusline verdict into red-setup's closing recap", async () => {
    const contract = await readDoc(`${SETUP}/WRITE-CONTRACT.md`);

    const doneAt = contract.indexOf("## Done");
    expect(doneAt).toBeGreaterThan(-1);
    expect(contract.slice(doneAt)).toContain("written, restart needed");
  });

  it("states the next-session fact in the interview section that offers it", async () => {
    const interview = await readDoc(`${SETUP}/INTERVIEW.md`);

    expect(interview).toContain("takes effect in the next session, not this one");
    expect(interview).toContain("reloads plugins, not project settings");
  });

  it("keeps the restart verdict and the honest probe on red-statusline's hot path", async () => {
    const skill = await readDoc(`${STATUSLINE}/SKILL.md`);

    expect(skill).toContain("written, restart needed");
    expect(skill).toContain("proves the command, not the host wiring");
    expect(skill).toContain("restart, not misconfiguration");
  });

  it("frames the HOST-NOTES probe as proof of the command alone", async () => {
    const notes = await readDoc(`${STATUSLINE}/HOST-NOTES.md`);

    expect(notes).toContain("written, restart needed");
    expect(notes).toContain("proves the command, not the host wiring");
  });

  it("lists the stale session ahead of every other blank-statusline cause", async () => {
    const notes = await readDoc(`${STATUSLINE}/HOST-NOTES.md`);

    const stale = notes.indexOf("written during THIS session");
    const commandPath = notes.indexOf("node not on PATH");

    expect(stale, "HOST-NOTES.md names no stale-session cause").toBeGreaterThan(-1);
    expect(commandPath).toBeGreaterThan(-1);
    expect(stale, "the stale session must be diagnosed first").toBeLessThan(commandPath);
  });

  it("publishes the same guidance in the generated Pi mirrors", async () => {
    for (const path of [
      `${PI_SETUP}/WRITE-CONTRACT.md`,
      `${PI_SETUP}/INTERVIEW.md`,
      `${PI_STATUSLINE}/SKILL.md`,
      `${PI_STATUSLINE}/HOST-NOTES.md`,
    ]) {
      const doc = await readDoc(path);
      expect(doc, path).toContain(
        path.includes("INTERVIEW") ? "takes effect in the next session, not this one" : "written, restart needed",
      );
    }
  });
});
