import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ensureCodexTaskProgress,
  formatCodexStatusLine,
  inspectCodexStatuslineConfig,
} from "../src/core/codex-statusline.js";
import { codexStatuslineCommand } from "../src/commands/codex-statusline.js";

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

describe("codex statusline config inspection", () => {
  it("detects a custom footer that omits task-progress", () => {
    const out = inspectCodexStatuslineConfig(`
[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
`);
    expect(out.problem).toBe("missing-task-progress");
    expect(out.hasTaskProgress).toBe(false);
    expect(out.statusLine).toEqual(["model-with-reasoning", "context-remaining", "current-dir"]);
  });

  it("reports ok when task-progress is present", () => {
    const out = inspectCodexStatuslineConfig(`
[tui]
status_line = ["model-with-reasoning", "task-progress"]
`);
    expect(out.problem).toBeNull();
    expect(out.hasTaskProgress).toBe(true);
  });

  it("treats an empty footer as an intentional hide", () => {
    const out = inspectCodexStatuslineConfig(`
[tui]
status_line = []
`);
    expect(out.problem).toBe("hidden");
    expect(out.hidden).toBe(true);
  });

  it("appends task-progress after current-dir without changing other widgets", () => {
    const text = `
[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir", "used-tokens"]
`;
    expect(ensureCodexTaskProgress(text)).toContain(
      'status_line = ["model-with-reasoning", "context-remaining", "current-dir", "task-progress", "used-tokens"]',
    );
  });

  it("inserts a recommended footer when the tui table has no status_line", () => {
    const text = `
[tui]
notifications = false
`;
    const next = ensureCodexTaskProgress(text);
    expect(next).toContain("notifications = false");
    expect(next).toContain(`status_line = ${formatCodexStatusLine([
      "project",
      "git-branch",
      "model-with-reasoning",
      "context-remaining",
      "task-progress",
    ])}`);
  });
});

describe("codex-statusline command", () => {
  it("prints a warning and can fix a missing task-progress footer", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-statusline-"));
    const config = join(root, "config.toml");
    await writeFile(config, '[tui]\nstatus_line = ["model-with-reasoning", "current-dir"]\n', "utf8");
    try {
      const warn = sink();
      await codexStatuslineCommand(["--config", config], warn.stream);
      expect(warn.text()).toContain("codex-statusline: warn");
      expect(warn.text()).toContain("task-progress is missing");

      const fixed = sink();
      await codexStatuslineCommand(["--config", config, "--fix"], fixed.stream);
      expect(fixed.text()).toContain("codex-statusline: ok");
      expect(fixed.text()).toContain("updated: added task-progress");
      expect(await readFile(config, "utf8")).toContain('"task-progress"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
