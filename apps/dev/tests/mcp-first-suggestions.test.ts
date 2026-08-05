import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCodexMonitorAgentPrompt } from "../src/core/codex-monitor-agent.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * ADR 0120/0123: the castle MCP is the canonical interface, so every
 * agent-facing suggestion names the MCP tool first. A `red-skills-dev` CLI
 * invocation survives only when the surrounding text labels it, verbatim, as
 * the `no-MCP fallback` — an exact phrase so the label has to be deliberate.
 */
const NO_MCP_LABEL = "no-MCP fallback";
const LABEL_WINDOW = 3;

/** Surfaces from the #2668 census, plus the docs that pin their printed strings. */
const CENSUS = [
  "apps/dev/src/commands/codex-statusline.ts",
  "apps/dev/src/core/codex-monitor-agent.ts",
  "plugins/dev/skills/engineering/afk/monitor.md",
  "plugins/dev/skills/engineering/afk/fleet.md",
  "plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md",
  "plugins/dev/skills/engineering/afk/docs/CONFIG.md",
  "plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md",
  "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
] as const;

function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

/** Lines mentioning the monitor CLI that no nearby `no-MCP fallback` label covers. */
function unlabelledCliSuggestions(text: string): string[] {
  const lines = text.split("\n");
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes("red-skills-dev monitor"))
    .filter(({ index }) =>
      !lines
        .slice(Math.max(0, index - LABEL_WINDOW), index + 1)
        .some((candidate) => candidate.toLowerCase().includes(NO_MCP_LABEL.toLowerCase())),
    )
    .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
}

describe("MCP-first suggestion compliance", () => {
  it("labels every surviving monitor CLI suggestion as the no-MCP fallback", async () => {
    for (const path of CENSUS) {
      const text = await readRepoFile(path);
      expect(unlabelledCliSuggestions(text), `${path} names the CLI without a ${NO_MCP_LABEL} label`)
        .toEqual([]);
    }
  });

  it("names castle MCP tools verbatim wherever the monitor CLI still appears", async () => {
    const mcpDoc = await readRepoFile("plugins/dev/skills/engineering/afk/MCP.md");
    const toolNames = Array.from(
      mcpDoc.matchAll(/^\| `([a-z][a-z_]*)` \| (?:read|mutating) \|/gm),
      (match) => match[1] as string,
    );
    expect(toolNames.length).toBeGreaterThan(0);

    for (const path of CENSUS) {
      const text = await readRepoFile(path);
      if (!text.includes("red-skills-dev monitor")) continue;
      const named = toolNames.filter((tool) => text.includes(`\`${tool}\``));
      expect(named, `${path} should name a castle tool from MCP.md verbatim`).not.toEqual([]);
    }
  });

  it("makes the Codex monitor agent poll scoped castle status first", () => {
    const prompt = renderCodexMonitorAgentPrompt({ projectRoot: "/repo", mode: "fleet" });

    expect(prompt).toContain("castle `status` tool");
    expect(prompt).toContain("scope: worker");
    expect(prompt.indexOf("castle `status` tool")).toBeLessThan(
      prompt.indexOf("red-skills-dev monitor --once"),
    );
    expect(prompt).toContain(NO_MCP_LABEL);
  });
});
