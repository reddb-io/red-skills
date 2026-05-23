import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-improve-skills-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

function skillResultEvent(i: number, skillFile: string, status: "failed" | "succeeded") {
  return {
    event_type: "result",
    event_id: `evt-${i}`,
    timestamp: `2026-05-22T16:0${i}:00.000Z`,
    session_id: "s1",
    turn_id: `t${i}`,
    name: "flaky-skill",
    source_kind: "project",
    path: skillFile,
    runner: "claude",
    result: {
      status,
      error_class: status === "failed" ? "ValidationError" : undefined,
      error_stage: status === "failed" ? "verify" : undefined,
    },
  };
}

function structuredProposal(path: string, oldString: string, newString: string): string {
  return [
    "# Skill Improvement Proposal: flaky-skill",
    "",
    "## Apply Patch",
    "",
    "```json memory-skill-patch",
    JSON.stringify({ path, oldString, newString }, null, 2),
    "```",
    "",
  ].join("\n");
}

describe("memory improve skills CLI", () => {
  test(
    "writes an approval-gated proposal from failing skill telemetry without mutating the skill",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      const skillDir = join(root, "skills", "flaky-skill");
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      const skillBody = "---\nname: flaky-skill\ndescription: fixture\n---\n\n# flaky-skill\n\nOriginal content.\n";
      await writeFile(skillFile, skillBody, "utf8");
      const before = await stat(skillFile);

      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const result = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);

      expect(body.state).toBe("proposal-written");
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0].skill).toBe("flaky-skill");
      expect(body.proposals[0].path).toContain(".red/memory/proposals/");

      const files = await readdir(join(root, ".red", "memory", "proposals"));
      expect(files).toHaveLength(1);
      const proposal = await readFile(join(root, ".red", "memory", "proposals", files[0]), "utf8");
      expect(proposal).toContain("# Skill Improvement Proposal: flaky-skill");
      expect(proposal).toContain("frequently-failing");
      expect(proposal).toContain("4/5 results failed (80%)");
      expect(proposal).toContain("## Proposed Patch");
      expect(proposal).toContain("approval-gated");

      expect(await readFile(skillFile, "utf8")).toBe(skillBody);
      const after = await stat(skillFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
    TIMEOUT,
  );

  test(
    "dry-run reports candidate proposals without writing files",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "# skill\n", "utf8");
      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], JSON.stringify(events));
      expect(ingest.status).toBe(0);

      const result = runMemory(["improve", "skills", "--root", root, "--json"]);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.state).toBe("proposal-ready");
      expect(body.proposals[0].written).toBe(false);

      await expect(readdir(join(root, ".red", "memory", "proposals"))).rejects.toThrow();
    },
    TIMEOUT,
  );

  test(
    "applies a reviewed proposal only with explicit --yes and a structured patch block",
    async () => {
      const root = await tempRoot();
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "# flaky-skill\n\nOriginal content.\n", "utf8");
      const proposalFile = join(root, ".red", "memory", "proposals", "proposal.md");
      await mkdir(dirname(proposalFile), { recursive: true });
      await writeFile(
        proposalFile,
        structuredProposal("skills/flaky-skill/SKILL.md", "Original content.", "Improved content."),
        "utf8",
      );

      const blocked = runMemory(["improve", "apply", proposalFile, "--root", root, "--json"]);
      expect(blocked.status).not.toBe(0);
      expect(await readFile(skillFile, "utf8")).toContain("Original content.");

      const applied = runMemory(["improve", "apply", proposalFile, "--root", root, "--yes", "--json"]);
      expect(applied.status).toBe(0);
      const body = JSON.parse(applied.stdout);
      expect(body.state).toBe("applied");
      expect(body.target).toBe("skills/flaky-skill/SKILL.md");
      expect(await readFile(skillFile, "utf8")).toContain("Improved content.");
    },
    TIMEOUT,
  );

  test(
    "refuses proposals without a structured apply block",
    async () => {
      const root = await tempRoot();
      const proposalFile = join(root, ".red", "memory", "proposals", "proposal.md");
      await mkdir(dirname(proposalFile), { recursive: true });
      await writeFile(proposalFile, "# proposal\n\n## Proposed Patch\n\nPatch the skill manually.\n", "utf8");

      const result = runMemory(["improve", "apply", proposalFile, "--root", root, "--yes", "--json"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("structured memory-skill-patch block");
    },
    TIMEOUT,
  );
});
