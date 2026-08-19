import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("Validation moments documentation (ADR 0135, #3289)", () => {
  it("states the complete schedule and its host concurrency knob in one reference", async () => {
    const config = await readRepoFile("plugins/dev/skills/engineering/afk/docs/CONFIG.md");

    expect(config).toContain("### Validation moments");
    expect(config).toContain("`plugins.dev.afk.validation.iteration`");
    expect(config).toContain("`plugins.dev.afk.validation.post_done`");
    expect(config).toContain("`plugins.dev.afk.validation.landing`");
    expect(config).toContain("CI-side final Validation moment");
    expect(config).toContain("`plugins.dev.redskilled.validation_ceiling`");
    expect(config).toContain("omitted moment is skipped loudly");
  });

  it("teaches AFK and Go through declared moments, not retired discovery defaults", async () => {
    const [afk, go, config] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/afk/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/go/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/docs/CONFIG.md"),
    ]);

    expect(afk).toContain("`plugins.dev.afk.validation`");
    expect(afk).toContain("undeclared moment is skipped loudly");
    expect(afk).not.toContain("Feedback plus the operator's");
    expect(afk).not.toContain("replaces feedback script discovery");

    expect(go).toContain("declared `post_done` Validation moment");
    expect(go).toContain("`--verify` appends one command to `post_done`");
    expect(go).not.toContain("normal feedback harness");
    expect(go).not.toContain("feedback/backpressure");
    expect(go).not.toContain("RED_GATE_STALE_BASE_CORRECTIONS");

    expect(config).toContain("#### Deprecated `post_done` aliases");
    expect(config).not.toContain("When the key is absent, discovery is byte-for-byte unchanged");
  });

  it("keeps the generated Pi skill mirrors byte-identical", async () => {
    const paths = [
      "skills/engineering/afk/SKILL.md",
      "skills/engineering/afk/docs/CONFIG.md",
      "skills/engineering/go/SKILL.md",
    ];

    for (const path of paths) {
      const [source, mirror] = await Promise.all([
        readRepoFile(`plugins/dev/${path}`),
        readRepoFile(`packaging/pi/dev/${path}`),
      ]);
      expect(mirror).toBe(source);
    }
  });
});
