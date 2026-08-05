import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "@reddb-io/red-castle/mcp-server";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const AFK = "plugins/dev/skills/engineering/afk";
const MCP_DOC = `${AFK}/MCP.md`;

function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

const tools = createCastleMcpTools({} as CastleMcpDependencies);
const intentTools = tools.filter((tool) => !tool.description.startsWith("DEPRECATED:"));

interface DocumentedTool {
  readonly name: string;
  readonly mode: string;
}

function documentedTools(doc: string): DocumentedTool[] {
  return Array.from(doc.matchAll(/^\| `([a-z][a-z_]*)` \| (read|mutating) \|/gm), (match) => ({
    name: match[1] as string,
    mode: match[2] as string,
  }));
}

describe("castle MCP client docs contract", () => {
  it("documents every canonical castle intent exactly once in MCP.md", async () => {
    const doc = await readRepoFile(MCP_DOC);
    const documented = documentedTools(doc).map((entry) => entry.name);

    expect([...documented].sort()).toEqual([...intentTools.map((tool) => tool.name)].sort());
  });

  it("marks each documented intent with the mutation mode its description declares", async () => {
    const doc = await readRepoFile(MCP_DOC);
    const modeByName = new Map(documentedTools(doc).map((entry) => [entry.name, entry.mode]));

    for (const tool of intentTools) {
      const expected = tool.description.startsWith("MUTATING:") ? "mutating" : "read";
      expect(modeByName.get(tool.name), `${tool.name} mode`).toBe(expected);
    }
  });

  it("names the server, the host prefix rule, and the CLI fallback", async () => {
    const doc = await readRepoFile(MCP_DOC);

    expect(doc).toContain("`castle` MCP");
    expect(doc).toContain("mcp__");
    expect(doc).toContain("red-skills-dev");
  });

  it("makes /afk drive the castle through the castle MCP tools", async () => {
    const skill = await readRepoFile(`${AFK}/SKILL.md`);

    expect(skill).toContain("`castle` MCP");
    expect(skill).toContain("[`MCP.md`](./MCP.md)");
    for (const tool of ["queue_status", "worker_dispatch"]) {
      expect(skill, `/afk should route through ${tool}`).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("`status {scope:");
  });

  it("makes /go dispatch through the same MCP surface", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/go/SKILL.md");

    expect(skill).toContain("`castle` MCP");
    expect(skill).toContain("../afk/MCP.md");
    expect(skill).toContain("`worker_dispatch`");
  });

  it("routes the fleet and observability verbs through the project tools", async () => {
    const [fleet, monitor] = await Promise.all([
      readRepoFile(`${AFK}/fleet.md`),
      readRepoFile(`${AFK}/monitor.md`),
    ]);

    for (const tool of ["project_start", "status", "project_resize", "project_reset", "project_stop", "logs"]) {
      expect(fleet, `fleet.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
    for (const tool of ["monitor", "worker_vitals", "queue_status"]) {
      expect(monitor, `monitor.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
  });

  it("makes every castle-verb skill an MCP-first client of its tools", async () => {
    // Skill → the tools its SKILL.md must name (plus the shared client markers).
    const clients: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["hitl", ["requeue", "hitl_resolve"]],
      ["triage", ["triage"]],
      ["retake", ["retake", "requeue"]],
      ["dashboard", ["dashboard"]],
      ["daily-review", ["daily_review", "weekly_review"]],
    ];

    for (const [skillName, skillTools] of clients) {
      const skill = await readRepoFile(
        `plugins/dev/skills/engineering/${skillName}/SKILL.md`,
      );
      expect(skill, `/${skillName} should name the castle MCP`).toContain("`castle` MCP");
      expect(skill, `/${skillName} should link the tool surface doc`).toContain("../afk/MCP.md");
      for (const tool of skillTools) {
        expect(skill, `/${skillName} should route through ${tool}`).toContain(`\`${tool}\``);
      }
    }
  });

  // #3062: a plugin installed mid-session has its MCP declaration written and
  // its servers never started. An agent that falls straight to the CLI treats a
  // load-lifecycle gap as an outage and re-derives a one-line cure forensically.
  it("makes /reload-plugins the FIRST step of the MCP-unreachable path", async () => {
    const paths = [
      `${AFK}/SKILL.md`,
      `${AFK}/MCP.md`,
      "plugins/dev/skills/engineering/go/SKILL.md",
    ];

    for (const path of paths) {
      // Prose wraps, so the assertions read the doc with its line breaks
      // collapsed — a sentence split across two lines is the same sentence.
      const doc = (await readRepoFile(path)).replace(/\s+/g, " ");
      expect(doc, `${path} should name the reload cure`).toContain("/reload-plugins");
      expect(doc, `${path} should name the mid-session install`).toContain("installed or updated in THIS session");

      // Order is the contract: the reload question must precede the CLI
      // fallback, or the fallback hides the gap it should have caught.
      const reloadAt = doc.indexOf("/reload-plugins");
      const fallbackAt = doc.indexOf("Only once the reload is ruled out");
      expect(fallbackAt, `${path} should gate the fallback behind the reload check`).toBeGreaterThan(-1);
      expect(reloadAt, `${path} should ask about reload before falling back`).toBeLessThan(fallbackAt);
    }
  });

  it("keeps the ask-red router pointing at the castle MCP", async () => {
    const askRed = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRed).toContain("`castle` MCP");
    expect(askRed).toContain(MCP_DOC);
  });

  it("records the MCP decision as ADR 0120 with an index bullet", async () => {
    const [adr, index] = await Promise.all([
      readRepoFile(".red/adr/0120-red-castle-is-the-afk-mcp.md"),
      readRepoFile(".red/adr/INDEX.md"),
    ]);

    expect(adr).toContain("# 0120 —");
    expect(adr).toContain("## Decision");
    expect(index).toContain("- **0120**");
  });
});
