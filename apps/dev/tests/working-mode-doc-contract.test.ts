import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  CLIENT_BOOT_PHASES,
  PLUGIN_MCP_SERVERS,
  THIN_ENTRANCE_SKILLS,
  WORKING_MODE_DOC_CONTRACT,
  auditClientBootPhases,
  auditDocContract,
  describeDocContractFindings,
  discoveredTools,
  namesTool,
} from "../src/core/working-mode-doc-contract.js";
import { createCastleMcpTools, type CastleMcpDependencies } from "../src/mcp-tools/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PUBLISHED = createCastleMcpTools({} as CastleMcpDependencies).map((tool) => tool.name);

/** Writes one SKILL.md into a throwaway plugin tree and returns its root. */
async function fixture(body: string, path = "plugins/example/skills/core/fixture"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-doc-contract-"));
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "SKILL.md"), body);
  return root;
}

function skill(mode: string, body = ""): string {
  return ["---", "name: fixture", `working-mode: ${mode}`, "description: A fixture.", "---", "", body, ""].join("\n");
}

const FIXTURE_SKILL = "plugins/example/skills/core/fixture/SKILL.md";

describe("Working-mode doc contract (ADR 0147 rule 2, ADR 0150 §2, #4030)", () => {
  it("binds only shipped Plugin MCPs", () => {
    for (const entry of WORKING_MODE_DOC_CONTRACT) {
      expect(PLUGIN_MCP_SERVERS, `${entry.skill} names a shipped server`).toContain(entry.server);
    }
  });

  it("states why each skill needs its tools", () => {
    for (const entry of WORKING_MODE_DOC_CONTRACT) {
      expect(entry.why.length, `${entry.skill} states its use`).toBeGreaterThan(20);
      expect(entry.tools.length, `${entry.skill} binds at least one tool`).toBeGreaterThan(0);
    }
  });

  it("reads a tool name out of a code span, opened or closed", () => {
    expect(namesTool("call `queue_status` first", "queue_status")).toBe(true);
    expect(namesTool("call `status {scope: worker}`", "status")).toBe(true);
    expect(namesTool("the queue_status field", "queue_status")).toBe(false);
  });

  it("discovers only the unambiguous underscore-bearing names", () => {
    const text = "read `queue_status`, then `status` and `help`";

    expect(discoveredTools(text, ["queue_status", "status", "help"])).toEqual(["queue_status"]);
  });

  it("flags a binding to a tool the surface does not publish", async () => {
    const root = await fixture(skill("interactive", "Call `ghost_tool` for it."));

    const findings = auditDocContract(root, PUBLISHED, [
      { skill: FIXTURE_SKILL, mode: "interactive", server: "rs_dev", tools: ["ghost_tool"], why: "x".repeat(30) },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ defect: "unpublished-tool", subject: "ghost_tool" });
    expect(describeDocContractFindings(findings)).toContain("ghost_tool");
  });

  it("flags a binding the skill stopped naming", async () => {
    const root = await fixture(skill("interactive", "No tools here."));

    const findings = auditDocContract(root, PUBLISHED, [
      { skill: FIXTURE_SKILL, mode: "interactive", server: "rs_dev", tools: ["queue_status"], why: "x".repeat(30) },
    ]);

    expect(findings.map((finding) => finding.defect)).toContain("unnamed-tool");
  });

  it("flags a tool a skill names without declaring", async () => {
    const root = await fixture(skill("interactive", "Call `queue_status` for it."));

    const findings = auditDocContract(root, PUBLISHED, []);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ defect: "undeclared-tool", subject: "queue_status" });
  });

  it("flags a binding whose declared mode contradicts the header", async () => {
    const root = await fixture(skill("ad-hoc", "Call `queue_status` for it."));

    const findings = auditDocContract(root, PUBLISHED, [
      { skill: FIXTURE_SKILL, mode: "interactive", server: "rs_dev", tools: ["queue_status"], why: "x".repeat(30) },
    ]);

    expect(findings.map((finding) => finding.defect)).toContain("mode-mismatch");
  });

  it("flags a binding whose skill is gone", async () => {
    const root = await fixture(skill("interactive"));

    const findings = auditDocContract(root, PUBLISHED, [
      { skill: "plugins/example/skills/core/ghost/SKILL.md", mode: "interactive", server: "rs_dev", tools: ["queue_status"], why: "x".repeat(30) },
    ]);

    expect(findings.map((finding) => finding.defect)).toContain("missing-skill");
  });

  it("holds every shipped skill to its declared tool binding", () => {
    const findings = auditDocContract(ROOT, PUBLISHED);

    expect(findings, describeDocContractFindings(findings)).toEqual([]);
  });

  it("runs in every cone-scoped gate run", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:working-mode-doc-contract");
  });
});

describe("the thin entrances name no client boot phase (ADR 0150 §3)", () => {
  it("holds exactly /afk and /go", () => {
    expect(THIN_ENTRANCE_SKILLS).toEqual([
      "plugins/dev/skills/engineering/afk/SKILL.md",
      "plugins/dev/skills/engineering/go/SKILL.md",
    ]);
  });

  it("leaves the trust gate out — it moved into admission rather than dying", () => {
    expect(CLIENT_BOOT_PHASES.some((phase) => phase.includes("trust"))).toBe(false);
  });

  it("flags a fixture entrance that still runs a boot phase", async () => {
    const root = await fixture(skill("spec-driven", "First run the boot sweeps, then dispatch."));

    const findings = auditClientBootPhases(root, [FIXTURE_SKILL]);

    expect(findings.map((finding) => finding.subject)).toContain("boot sweep");
    expect(findings[0]?.defect).toBe("client-boot-phase");
  });

  it("passes on the same fixture once the phase is gone", async () => {
    const root = await fixture(skill("spec-driven", "Register, arm the drain, observe."));

    expect(auditClientBootPhases(root, [FIXTURE_SKILL])).toEqual([]);
  });

  it("/afk and /go name no client boot phase", () => {
    const findings = auditClientBootPhases(ROOT);

    expect(findings, describeDocContractFindings(findings)).toEqual([]);
  });
});
