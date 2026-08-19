import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "../src/mcp-tools/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const AFK = "plugins/dev/skills/engineering/afk";
const MCP_DOC = `${AFK}/MCP.md`;

function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

async function markdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(ROOT, root), { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
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

describe("rs_dev MCP client docs contract", () => {
  it("documents every canonical execution intent exactly once in MCP.md", async () => {
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

    expect(doc).toContain("`rs_dev` MCP");
    expect(doc).toContain("mcp__");
    expect(doc).toContain("red-skills-dev");
  });

  it("makes /afk drive execution through the rs_dev MCP tools", async () => {
    const skill = await readRepoFile(`${AFK}/SKILL.md`);

    expect(skill).toContain("`rs_dev` MCP");
    expect(skill).toContain("[`MCP.md`](./MCP.md)");
    for (const tool of ["queue_status", "worker_dispatch"]) {
      expect(skill, `/afk should route through ${tool}`).toContain(`\`${tool}\``);
    }
    expect(skill).toContain("`status {scope:");
  });

  it("makes /go dispatch through the same MCP surface", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/go/SKILL.md");

    expect(skill).toContain("`rs_dev` MCP");
    expect(skill).toContain("../afk/MCP.md");
    expect(skill).toContain("`worker_dispatch`");
  });

  it("routes fleet and observability reads through the intent surface", async () => {
    const [fleet, monitor] = await Promise.all([
      readRepoFile(`${AFK}/fleet.md`),
      readRepoFile(`${AFK}/monitor.md`),
    ]);

    for (const tool of ["project_start", "status", "project_resize", "project_reset", "project_stop", "logs"]) {
      expect(fleet, `fleet.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
    for (const tool of ["status", "queue_status"]) {
      expect(monitor, `monitor.md should route through ${tool}`).toContain(`\`${tool}\``);
    }
    expect(monitor).not.toContain("`worker_status`");
    expect(monitor).not.toContain("`worker_vitals`");
    expect(monitor).not.toContain("rs_dev `monitor` tool");
  });

  it("makes every execution-verb skill an MCP-first client of its tools", async () => {
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
      expect(skill, `/${skillName} should name the rs_dev MCP`).toContain("`rs_dev` MCP");
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

  it("keeps the ask-red router pointing at the rs_dev MCP", async () => {
    const askRed = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRed).toContain("`rs_dev` MCP");
    expect(askRed).toContain(MCP_DOC);
  });

  // Two retired MCP names now, not one. `castle` left with ADR 0142; `redskilled`
  // left with ADR 0147 rule 2 (#4023) — it is still the daemon, the binary and
  // the host service, so only the spellings that address it AS A SERVER are
  // reddened. "hands the queue to redskilled" is the daemon and stays.
  it("keeps every published skill and disclosed reference off a retired MCP name", async () => {
    const paths = await markdownFiles("plugins");
    const stale: string[] = [];
    let rsDevReferences = 0;
    const retired = [
      /`castle`\s+MCP/i,
      /(?<!red-)\bcastle\s+MCP\b/i,
      /(?<!red-)\bcastle\s+`[a-z][a-z_]*(?:\s+\{[^`]*\})?`/i,
      /mcp__[^\s`]*castle/i,
      /(?<!sand)castle:(?:drain|diagnose|configure|stop)\b/i,
      /`redskilled`\s+MCP/i,
      /\bredskilled\s+MCP\b/i,
      /\bredskilled\s+`[a-z][a-z_]*(?:\s+\{[^`]*\})?`/i,
      /mcp__[^\s`]*_redskilled__/i,
      /\bredskilled:(?:drain|diagnose|configure|stop)\b/i,
    ];

    for (const path of paths) {
      const source = await readRepoFile(path);
      if (/`rs_dev`\s+MCP|\brs_dev\s+`[a-z][a-z_]*`/i.test(source)) {
        rsDevReferences += 1;
      }
      source.split("\n").forEach((line, index) => {
        if (retired.some((pattern) => pattern.test(line))) {
          stale.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(paths.length).toBeGreaterThan(50);
    expect(rsDevReferences).toBeGreaterThan(8);
    expect(stale).toEqual([]);
  });

  it("records the capability and naming decisions in ADRs 0120 and 0142", async () => {
    const [capabilityAdr, namingAdr, index] = await Promise.all([
      readRepoFile(".red/adr/0120-red-castle-is-the-afk-mcp.md"),
      readRepoFile(".red/adr/0142-redskilled-is-the-public-mcp-name.md"),
      readRepoFile(".red/adr/INDEX.md"),
    ]);

    expect(capabilityAdr).toContain("# 0120 —");
    expect(capabilityAdr).toContain("## Decision");
    expect(namingAdr).toContain("# 0142 —");
    expect(namingAdr).toContain("npx -y -p @reddb-io/red-skills@<version>");
    expect(index).toContain("- **0120**");
    expect(index).toContain("- **0142**");
  });
});
