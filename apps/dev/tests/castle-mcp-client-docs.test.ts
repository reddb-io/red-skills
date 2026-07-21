import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "../../../packages/red-castle/src/mcp-server.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const AFK = "plugins/dev/skills/engineering/afk";
const MCP_DOC = `${AFK}/MCP.md`;

function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

const tools = createCastleMcpTools({} as CastleMcpDependencies);

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
  it("documents every dev:afk MCP tool exactly once in MCP.md", async () => {
    const doc = await readRepoFile(MCP_DOC);
    const documented = documentedTools(doc).map((entry) => entry.name);

    expect([...documented].sort()).toEqual([...tools.map((tool) => tool.name)].sort());
  });

  it("marks each documented tool with the mutation mode its description declares", async () => {
    const doc = await readRepoFile(MCP_DOC);
    const modeByName = new Map(documentedTools(doc).map((entry) => [entry.name, entry.mode]));

    for (const tool of tools) {
      const expected = tool.description.startsWith("MUTATING:") ? "mutating" : "read";
      expect(modeByName.get(tool.name), `${tool.name} mode`).toBe(expected);
    }
  });

  it("names the server, the host prefix rule, and the CLI fallback", async () => {
    const doc = await readRepoFile(MCP_DOC);

    expect(doc).toContain("dev:afk");
    expect(doc).toContain("mcp__");
    expect(doc).toContain("red-skills-dev");
  });

  it("makes /afk drive the castle through the dev:afk MCP tools", async () => {
    const skill = await readRepoFile(`${AFK}/SKILL.md`);

    expect(skill).toContain("dev:afk");
    expect(skill).toContain("[`MCP.md`](./MCP.md)");
    for (const tool of ["queue_status", "worker_dispatch", "fleet_status", "monitor"]) {
      expect(skill, `/afk should route through ${tool}`).toContain(`\`${tool}\``);
    }
  });

  it("makes /go dispatch through the same MCP surface", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/go/SKILL.md");

    expect(skill).toContain("dev:afk");
    expect(skill).toContain("../afk/MCP.md");
    expect(skill).toContain("`worker_dispatch`");
  });

  it("routes the fleet and observability verbs through named-fleet tools", async () => {
    const [fleet, monitor] = await Promise.all([
      readRepoFile(`${AFK}/fleet.md`),
      readRepoFile(`${AFK}/monitor.md`),
    ]);

    for (const tool of ["fleet_create", "fleet_status", "fleet_edit", "fleet_stop", "logs"]) {
      expect(fleet, `fleet.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
    for (const tool of ["monitor", "worker_vitals", "queue_status"]) {
      expect(monitor, `monitor.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
  });

  it("keeps the ask-red router pointing at the dev:afk MCP", async () => {
    const askRed = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRed).toContain("dev:afk");
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
