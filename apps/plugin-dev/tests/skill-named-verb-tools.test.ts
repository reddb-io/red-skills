import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_COMMAND_VERBS,
  SKILL_NAMED_VERB_TOOLS,
  UNNAMED_DEV_COMMANDS,
  collectSkillNamedVerbs,
  skillMarkdownFiles,
} from "../src/core/skill-named-verb-tools.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "../src/mcp-tools/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const MCP_TOOLS_DIR = join(ROOT, "apps/plugin-dev/src/mcp-tools");

const publishedTools = createCastleMcpTools({} as CastleMcpDependencies).map((tool) => tool.name);
const namedSites = collectSkillNamedVerbs(ROOT);
const namedVerbs = [...new Set(namedSites.map((site) => site.verb))].sort();
const toolForVerb = new Map(SKILL_NAMED_VERB_TOOLS.map((entry) => [entry.verb, entry.tool]));

/**
 * ADR 0147 rule 1: a command some skill still names becomes a tool of the plugin's
 * MCP, and a command no skill names dies with the bundle. #4030 finished the
 * migration, so the sweep now proves the ZERO state — no shipped skill names the
 * deleted binary — while the ledger it produced keeps every promoted tool published.
 */
describe("skill-named verbs have rs_dev tools of the same core", () => {
  it("sweeps a non-empty shipped skill tree", () => {
    // A walker that reaches nothing is green for the wrong reason, which is the
    // failure mode that makes a ratchet decorative. The tree must be real; what
    // it must NOT contain is the next assertion.
    expect(skillMarkdownFiles(ROOT).length).toBeGreaterThan(20);
  });

  it("finds no shipped skill still naming the deleted binary", () => {
    const survivors = namedSites.map(
      (site) => `${site.path}:${site.line} runs the deleted CLI with \`${site.verb}\``,
    );

    expect(
      survivors,
      "ADR 0147 rule 1 deletes the dev CLI rather than deprecating it (#4030). Name the `rs_dev` tool that " +
        "carries the same core — the pairing is declared in " +
        "apps/plugin-dev/src/core/skill-named-verb-tools.ts (SKILL_NAMED_VERB_TOOLS).",
    ).toEqual([]);
    expect(namedVerbs).toEqual([]);
  });

  it("publishes every promoted tool on the composed rs_dev surface", () => {
    // The ledger is what keeps a promoted core from quietly leaving the surface
    // now that no skill text points at it any more.
    for (const entry of SKILL_NAMED_VERB_TOOLS) {
      expect(publishedTools, `\`${entry.verb}\` maps to \`${entry.tool}\``).toContain(entry.tool);
    }
    expect(toolForVerb.size).toBeGreaterThan(10);
  });

  it("states why each pairing is the same core", () => {
    for (const entry of SKILL_NAMED_VERB_TOOLS) {
      expect(entry.why.length, `\`${entry.verb}\` states its core`).toBeGreaterThan(20);
    }
  });
});

describe("the deletion list accounts for every command no skill names", () => {
  it("partitions the router's commands into named and unnamed", () => {
    const declared = [...toolForVerb.keys(), ...UNNAMED_DEV_COMMANDS.map((entry) => entry.command)];

    expect(
      declared.sort(),
      "every dev command is either named by a skill (and has a tool) or recorded for deletion",
    ).toEqual([...DEV_COMMAND_VERBS].sort());
    expect(new Set(declared).size, "no command is decided about twice").toBe(declared.length);
  });

  it("names the route that outlives each deleted command", () => {
    for (const entry of UNNAMED_DEV_COMMANDS) {
      expect(entry.route.length, `\`${entry.command}\` names its route`).toBeGreaterThan(10);
    }
  });
});

/**
 * The capture-and-reparse guard.
 *
 * A tool that shells out to the verb it replaced, captures the printout and parses
 * it back into data is two implementations of one answer, and the printout wins
 * every disagreement. So a tool module reaches a dependency and returns its value:
 * it imports no command module, writes to no stream, and parses no text back.
 */
describe("rs_dev tools return values, never captured renders", () => {
  const modules = readdirSync(MCP_TOOLS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("scans every tool module", () => {
    expect(modules.length).toBeGreaterThan(5);
  });

  it("imports no command module into the tool surface", () => {
    for (const name of modules) {
      const source = readFileSync(join(MCP_TOOLS_DIR, name), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
      const captured = imports.filter(
        (specifier) => specifier.includes("/commands/") || specifier.endsWith("/cli.js"),
      );
      expect(captured, `${name} reaches a rendering command instead of a value core`).toEqual([]);
    }
  });

  it("writes to no stream and reparses no printout", () => {
    for (const name of modules) {
      const source = readFileSync(join(MCP_TOOLS_DIR, name), "utf8");
      expect(source, `${name} writes a render`).not.toContain("process.stdout");
      expect(source, `${name} writes a render`).not.toContain("process.stderr");
      expect(source, `${name} reparses a printout`).not.toContain("JSON.parse");
    }
  });

  it("hands each promoted verb's tool the dependency's own value", async () => {
    // Identity, not equality: a tool that returned a copy would still be a tool
    // that re-derived the answer on the way out.
    const answers = new Map<string, object>();
    const record = (tool: string) => {
      const answer = { tool };
      answers.set(tool, answer);
      return async () => answer;
    };
    const deps = {
      manager: record("manager"),
      redDoctor: record("red_doctor"),
      auditSkills: record("audit_skills"),
      installTypeLabels: record("install_type_labels"),
      codexStatusline: record("codex_statusline"),
      codexMonitorAgent: record("codex_monitor_agent"),
      reconcileEngine: record("reconcile_engine"),
    } as unknown as CastleMcpDependencies;

    for (const [name, answer] of answers) {
      const tool = createCastleMcpTools(deps).find((entry) => entry.name === name);
      expect(tool, `${name} is published`).toBeDefined();
      await expect(tool!.invoke({})).resolves.toBe(answer);
    }
  });
});

describe("the ratchet runs in every gate run", () => {
  it("is a declared repo-wide invariant", () => {
    // The skill tree and the tool surface live in different packages, so a
    // cone-scoped gate that touched only one of them would never see the drift.
    expect(REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:skill-named-verbs")).toMatchObject({
      scope: "apps/plugin-dev",
      script: "test:invariants",
    });
  });
});
