import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";

const TIMEOUT = 90_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];

function stableProposalText(markdown: string): string {
  return markdown.replace(/^Generated: .+$/m, "Generated: <stable>");
}

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

function skillResultEvent(
  i: number,
  skillFile: string,
  status: "failed" | "succeeded",
  name = "flaky-skill",
  errorStage = "verify",
  errorClass = "ValidationError",
) {
  return {
    event_type: "result",
    event_id: `${name}-evt-${i}`,
    timestamp: `2026-05-22T16:${String(i).padStart(2, "0")}:00.000Z`,
    session_id: "s1",
    turn_id: `${name}-t${i}`,
    name,
    source_kind: "project",
    path: skillFile,
    runner: "claude",
    result: {
      status,
      error_class: status === "failed" ? errorClass : undefined,
      error_stage: status === "failed" ? errorStage : undefined,
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
      expect(body.proposals[0].recentFailures).toBe(4);
      expect(body.proposals[0].dominantErrorStage).toBe("verify");
      expect(body.proposals[0].dominantErrorClass).toBe("ValidationError");
      expect(body.proposals[0].patchDrafted).toBe(true);
      expect(body.proposals[0].priority).toBe("high");
      expect(body.proposals[0].score).toBeGreaterThanOrEqual(0.8);
      expect(body.proposals[0].scoreReasons).toContain("failure ratio 80%");
      expect(body.proposals[0].scoreReasons).toContain("4 recent failure(s)");
      expect(body.proposals[0].scoreReasons).toContain("same error_stage repeated: verify");
      expect(body.proposals[0].scoreReasons).toContain("structured patch draft generated");
      expect(body.proposals[0].path).toContain(".red/memory/proposals/");
      expect(body.evidenceCards).toHaveLength(1);
      expect(body.evidenceCards[0]).toMatchObject({
        contract: "memory.evidence-card.experimental.v1",
        kind: "skill_telemetry",
        skill: "flaky-skill",
        written: true,
      });
      expect(body.evidenceCards[0].path).toContain(".red/memory/inbox/evidence/");
      expect(body.evidenceCards[0].proposalPath).toBe(body.proposals[0].path);

      const files = await readdir(join(root, ".red", "memory", "proposals"));
      expect(files).toHaveLength(1);
      const proposal = await readFile(join(root, ".red", "memory", "proposals", files[0]), "utf8");
      expect(proposal).toContain("# Skill Improvement Proposal: flaky-skill");
      expect(proposal).toContain("frequently-failing");
      expect(proposal).toContain("4/5 results failed (80%)");
      expect(proposal).toContain("## Proposed Patch");
      expect(proposal).toContain("```json memory-skill-patch");
      expect(proposal).toContain("## Evidence Card");
      expect(proposal).toContain(body.evidenceCards[0].id);
      expect(proposal).toContain(".red/memory/inbox/evidence/");
      expect(proposal).not.toContain("## Recent Failure Evidence");
      expect(proposal).not.toContain("error_stage=verify");
      expect(proposal).not.toContain("error_class=ValidationError");
      expect(proposal).toContain("Telemetry troubleshooting note");
      expect(proposal).toContain("verification guidance for the `verify` stage");
      expect(proposal).toContain("approval-gated");
      expect(proposal).toContain("## Evidence Card");
      expect(proposal).toContain(body.evidenceCards[0].id);

      const evidenceFiles = await readdir(join(root, ".red", "memory", "inbox", "evidence"));
      expect(evidenceFiles).toHaveLength(1);
      const card = await readFile(body.evidenceCards[0].path, "utf8");
      expect(card).toContain('contract: "memory.evidence-card.experimental.v1"');
      expect(card).toContain('kind: "skill_telemetry"');
      expect(card).toContain('source_kind: "project"');
      expect(card).toContain('runner: "claude"');
      expect(card).toContain('name: "flaky-skill"');
      expect(card).toContain('rollup_ref: "skill-rollup:');
      expect(card).toContain('- "skill-event:flaky-skill-evt-4"');
      expect(card).toContain('kind: "skill_proposal"');
      expect(card).toContain('target_skill_name: "flaky-skill"');
      expect(card).toContain('suggested_section_or_anchor: "stage:verify"');
      expect(card).toContain("external_audience: false");
      expect(card).toContain("customer_commercial_security: false");
      expect(card).toContain("shared_workflow_context: true");
      expect(card).toContain('derived_level: "medium"');
      expect(card).toContain("source_refs_not_raw_dump: true");
      expect(card).toContain('verdict: "proposal_ready"');
      expect(card).toContain('confidence: "high"');
      expect(card).toContain(`path: "${body.proposals[0].path.replace(`${root}/`, "")}"`);
      expect(card).not.toContain("session_id:");
      expect(card).not.toContain("turn_id:");

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
      expect(body.evidenceCards).toEqual([]);

      await expect(readdir(join(root, ".red", "memory", "proposals"))).rejects.toThrow();
      await expect(readdir(join(root, ".red", "memory", "inbox", "evidence"))).rejects.toThrow();
    },
    TIMEOUT,
  );

  test(
    "runs the governed self-improvement tracer bullet from telemetry through card review",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "---\nname: flaky-skill\ndescription: fixture\n---\n\n# flaky-skill\n\nOriginal content.\n", "utf8");
      const token = "sk-test_1234567890abcdefghijklmnopqrstuv";
      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ].map((event) =>
        event.result.status === "failed"
          ? { ...event, event_id: `${event.event_id}-${token}` }
          : event,
      );
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const first = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(first.status, first.stderr).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      expect(firstBody.state).toBe("proposal-written");
      expect(firstBody.proposals).toHaveLength(1);
      expect(firstBody.proposals[0]).toMatchObject({
        skill: "flaky-skill",
        written: true,
        reusedExisting: false,
        cardStatus: "proposed",
        evidenceSource: "skill-telemetry:flaky-skill:project",
        evidenceRoute: "skill-improvement:frequently-failing:skills/flaky-skill/SKILL.md",
        dominantErrorPattern: "stage=verify|class=ValidationError|code=",
      });
      expect(firstBody.proposals[0].fingerprint).toMatch(/^sha256:/);
      expect(firstBody.proposals[0].path).toContain(".red/memory/proposals/");
      expect(firstBody.evidenceCards).toHaveLength(1);
      expect(firstBody.evidenceCards[0]).toMatchObject({
        contract: "memory.evidence-card.experimental.v1",
        skill: "flaky-skill",
        status: "proposed",
        proposalPath: firstBody.proposals[0].path,
        reusedExisting: false,
        written: true,
      });

      const proposalBeforeReview = await readFile(firstBody.proposals[0].path, "utf8");
      expect(proposalBeforeReview).toContain("## Evidence Card");
      expect(proposalBeforeReview).toContain(firstBody.evidenceCards[0].id);
      expect(proposalBeforeReview).toContain(firstBody.evidenceCards[0].path.replace(`${root}/`, ""));
      expect(proposalBeforeReview).toContain("```json memory-skill-patch");
      expect(proposalBeforeReview).not.toContain(token);

      const cardBeforeReview = await readFile(firstBody.evidenceCards[0].path, "utf8");
      expect(cardBeforeReview).toContain('contract: "memory.evidence-card.experimental.v1"');
      expect(cardBeforeReview).toContain(`path: "${firstBody.proposals[0].path.replace(`${root}/`, "")}"`);
      expect(cardBeforeReview).toContain("[REDACTED:openai-token]");
      expect(cardBeforeReview).not.toContain(token);

      const second = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(second.status, second.stderr).toBe(0);
      const secondBody = JSON.parse(second.stdout);
      expect(secondBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(secondBody.proposals[0].reusedExisting).toBe(true);
      expect(secondBody.evidenceCards[0].id).toBe(firstBody.evidenceCards[0].id);
      expect(secondBody.evidenceCards[0].path).toBe(firstBody.evidenceCards[0].path);
      expect(secondBody.evidenceCards[0].reusedExisting).toBe(true);

      const approve = runMemory([
        "evidence",
        "approve",
        firstBody.evidenceCards[0].id,
        "--root",
        root,
        "--reviewer",
        "maintainer",
        "--yes",
        "--json",
      ]);
      expect(approve.status, approve.stderr).toBe(0);
      const approvedCard = await readFile(firstBody.evidenceCards[0].path, "utf8");
      expect(approvedCard).toContain('status: "approved"');
      expect(approvedCard).toContain('decision: "approved"');
      expect(stableProposalText(await readFile(firstBody.proposals[0].path, "utf8"))).toBe(
        stableProposalText(proposalBeforeReview),
      );

      const third = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(third.status, third.stderr).toBe(0);
      const thirdBody = JSON.parse(third.stdout);
      expect(thirdBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(thirdBody.proposals[0].reusedExisting).toBe(true);
      expect(thirdBody.evidenceCards[0].id).not.toBe(firstBody.evidenceCards[0].id);
      expect(await readFile(firstBody.evidenceCards[0].path, "utf8")).toBe(approvedCard);

      const reject = runMemory([
        "evidence",
        "reject",
        thirdBody.evidenceCards[0].id,
        "--root",
        root,
        "--reason",
        "tracer bullet rejected this evidence interpretation",
        "--reviewer",
        "maintainer",
        "--yes",
        "--json",
      ]);
      expect(reject.status, reject.stderr).toBe(0);
      const proposalAfterReject = await readFile(firstBody.proposals[0].path, "utf8");
      expect(proposalAfterReject).toContain("## Evidence Card Review Warning");
      expect(proposalAfterReject).toContain(`Evidence card id: ${thirdBody.evidenceCards[0].id}`);

      const applyWithoutApproval = runMemory(["improve", "apply", firstBody.proposals[0].path, "--root", root, "--json"]);
      expect(applyWithoutApproval.status).not.toBe(0);
      expect(applyWithoutApproval.stderr).toContain("requires explicit --yes approval");
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

  test(
    "lists, shows, and archives pending proposal files",
    async () => {
      const root = await tempRoot();
      const proposalDir = join(root, ".red", "memory", "proposals");
      await mkdir(proposalDir, { recursive: true });
      const proposalFile = join(proposalDir, "skill-improvement-flaky.md");
      await writeFile(
        proposalFile,
        [
          "# Skill Improvement Proposal: flaky-skill",
          "",
          "Status: approval-gated",
          "Generated: 2026-05-22T16:00:00.000Z",
          "",
          "## Evidence",
          "",
          "- Skill: flaky-skill",
          "- Category: frequently-failing",
          "- Reason: 4/5 results failed (80%)",
          "- Skill path: skills/flaky-skill/SKILL.md",
          "",
        ].join("\n"),
        "utf8",
      );

      const listed = runMemory(["improve", "proposals", "list", "--root", root, "--json"]);
      expect(listed.status).toBe(0);
      const listBody = JSON.parse(listed.stdout);
      expect(listBody.state).toBe("pending");
      expect(listBody.proposals).toHaveLength(1);
      expect(listBody.proposals[0]).toMatchObject({
        file: "skill-improvement-flaky.md",
        status: "pending",
        skill: "flaky-skill",
        category: "frequently-failing",
        reason: "4/5 results failed (80%)",
        skillPath: "skills/flaky-skill/SKILL.md",
      });

      const shown = runMemory(["improve", "proposals", "show", proposalFile, "--root", root, "--json"]);
      expect(shown.status).toBe(0);
      const showBody = JSON.parse(shown.stdout);
      expect(showBody.proposal.skill).toBe("flaky-skill");
      expect(showBody.body).toContain("# Skill Improvement Proposal: flaky-skill");

      const blocked = runMemory(["improve", "proposals", "archive", proposalFile, "--reason", "rejected", "--root", root, "--json"]);
      expect(blocked.status).not.toBe(0);

      const archived = runMemory(["improve", "proposals", "archive", proposalFile, "--reason", "rejected", "--root", root, "--yes", "--json"]);
      expect(archived.status).toBe(0);
      const archiveBody = JSON.parse(archived.stdout);
      expect(archiveBody.state).toBe("archived");
      expect(archiveBody.reason).toBe("rejected");
      expect(archiveBody.archivePath).toContain(".red/memory/proposals/archive/rejected/skill-improvement-flaky.md");

      const after = runMemory(["improve", "proposals", "list", "--root", root, "--json"]);
      expect(after.status).toBe(0);
      expect(JSON.parse(after.stdout).proposals).toHaveLength(0);
    },
    TIMEOUT,
  );


  test(
    "deduplicates pending proposals by deterministic fingerprint",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "---\nname: flaky-skill\ndescription: fixture\n---\n\n# flaky-skill\n\nOriginal content.\n", "utf8");
      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const first = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      expect(firstBody.proposals[0].fingerprint).toMatch(/^sha256:/);
      expect(firstBody.proposals[0].reusedExisting).toBe(false);
      expect(firstBody.evidenceCards).toHaveLength(1);
      expect(firstBody.evidenceCards[0].reusedExisting).toBe(false);
      const firstPath = firstBody.proposals[0].path;
      const firstCard = firstBody.evidenceCards[0];

      const second = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout);
      expect(secondBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(secondBody.proposals[0].path).toBe(firstPath);
      expect(secondBody.proposals[0].reusedExisting).toBe(true);
      expect(secondBody.evidenceCards).toHaveLength(1);
      expect(secondBody.evidenceCards[0].id).toBe(firstCard.id);
      expect(secondBody.evidenceCards[0].path).toBe(firstCard.path);
      expect(secondBody.evidenceCards[0].proposalPath).toBe(firstPath);
      expect(secondBody.evidenceCards[0].reusedExisting).toBe(true);

      const files = await readdir(join(root, ".red", "memory", "proposals"));
      expect(files.filter((file) => file.endsWith(".md"))).toHaveLength(1);
      const evidenceFiles = await readdir(join(root, ".red", "memory", "inbox", "evidence"));
      expect(evidenceFiles.filter((file) => file.endsWith(".yaml"))).toHaveLength(1);
      const proposal = await readFile(firstPath, "utf8");
      expect(proposal).toContain(`Fingerprint: ${firstBody.proposals[0].fingerprint}`);

      const archived = runMemory([
        "improve",
        "proposals",
        "archive",
        firstPath,
        "--reason",
        "rejected",
        "--root",
        root,
        "--yes",
        "--json",
      ]);
      expect(archived.status).toBe(0);

      const third = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(third.status).toBe(0);
      const thirdBody = JSON.parse(third.stdout);
      expect(thirdBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(thirdBody.proposals[0].path).toBe(firstPath);
      expect(thirdBody.proposals[0].reusedExisting).toBe(false);
      expect(thirdBody.evidenceCards[0].id).not.toBe(firstCard.id);
      expect(thirdBody.evidenceCards[0].path).not.toBe(firstCard.path);
      const regeneratedEvidenceFiles = await readdir(join(root, ".red", "memory", "inbox", "evidence"));
      expect(regeneratedEvidenceFiles.filter((file) => file.endsWith(".yaml"))).toHaveLength(2);

      const fourth = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(fourth.status).toBe(0);
      const fourthBody = JSON.parse(fourth.stdout);
      expect(fourthBody.proposals[0].reusedExisting).toBe(true);
      expect(fourthBody.evidenceCards[0].id).toBe(thirdBody.evidenceCards[0].id);
      expect(fourthBody.evidenceCards[0].path).toBe(thirdBody.evidenceCards[0].path);

      const listed = runMemory(["improve", "proposals", "list", "--root", root, "--json"]);
      expect(listed.status).toBe(0);
      const listedBody = JSON.parse(listed.stdout);
      expect(listedBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(firstBody.proposals[0].cardStatus).toBe("proposed");
      expect(firstBody.proposals[0].evidenceSource).toBe("skill-telemetry:flaky-skill:project");
      expect(firstBody.proposals[0].evidenceRoute).toBe("skill-improvement:frequently-failing:skills/flaky-skill/SKILL.md");
      expect(firstBody.proposals[0].dominantErrorPattern).toBe("stage=verify|class=ValidationError|code=");
      expect(firstBody.proposals[0].telemetryWindow).toBe(
        "2026-05-22T16:01:00.000Z..2026-05-22T16:04:00.000Z count=4",
      );
    },
    TIMEOUT,
  );

  test(
    "refreshes unresolved evidence cards by fingerprint without dropping review metadata",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "---\nname: flaky-skill\ndescription: fixture\n---\n\n# flaky-skill\n\nOriginal content.\n", "utf8");
      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const first = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      const firstCard = firstBody.evidenceCards[0];
      const original = await readFile(firstCard.path, "utf8");
      const routed = original
        .replace(/^status: "proposed"$/m, 'status: "routed"')
        .replace(/^  reviewer: null$/m, '  reviewer: "triager"')
        .replace(/^  notes: null$/m, '  notes: "keep active-review context"');
      await writeFile(firstCard.path, routed, "utf8");

      const second = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout);
      expect(secondBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(secondBody.proposals[0].reusedExisting).toBe(true);
      expect(secondBody.evidenceCards[0].id).toBe(firstCard.id);
      expect(secondBody.evidenceCards[0].path).toBe(firstCard.path);
      expect(secondBody.evidenceCards[0].reusedExisting).toBe(true);

      const evidenceFiles = await readdir(join(root, ".red", "memory", "inbox", "evidence"));
      expect(evidenceFiles.filter((file) => file.endsWith(".yaml"))).toHaveLength(1);
      const refreshed = await readFile(firstCard.path, "utf8");
      expect(refreshed).toContain('status: "proposed"');
      expect(refreshed).toContain('reviewer: "triager"');
      expect(refreshed).toContain('notes: "keep active-review context"');
    },
    TIMEOUT,
  );

  test(
    "preserves reviewed evidence cards and creates a new card for the same signal",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "flaky-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(skillFile, "---\nname: flaky-skill\ndescription: fixture\n---\n\n# flaky-skill\n\nOriginal content.\n", "utf8");
      const events = [
        skillResultEvent(1, skillFile, "failed"),
        skillResultEvent(2, skillFile, "failed"),
        skillResultEvent(3, skillFile, "failed"),
        skillResultEvent(4, skillFile, "failed"),
        skillResultEvent(5, skillFile, "succeeded"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const first = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      const firstCard = firstBody.evidenceCards[0];
      const approved = (await readFile(firstCard.path, "utf8"))
        .replace(/^status: "proposed"$/m, 'status: "approved"')
        .replace(/^  reviewer: null$/m, '  reviewer: "alice"')
        .replace(/^  reviewed_at: null$/m, '  reviewed_at: "2026-05-22T17:00:00.000Z"')
        .replace(/^  decision: null$/m, '  decision: "approved"')
        .replace(/^  notes: null$/m, '  notes: "keep this reviewed decision"');
      await writeFile(firstCard.path, approved, "utf8");

      const second = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout);
      expect(secondBody.proposals[0].fingerprint).toBe(firstBody.proposals[0].fingerprint);
      expect(secondBody.proposals[0].path).toBe(firstBody.proposals[0].path);
      expect(secondBody.proposals[0].reusedExisting).toBe(true);
      expect(secondBody.evidenceCards[0].id).not.toBe(firstCard.id);
      expect(secondBody.evidenceCards[0].path).not.toBe(firstCard.path);
      expect(secondBody.evidenceCards[0].reusedExisting).toBe(false);

      expect(await readFile(firstCard.path, "utf8")).toBe(approved);
      const evidenceFiles = await readdir(join(root, ".red", "memory", "inbox", "evidence"));
      expect(evidenceFiles.filter((file) => file.endsWith(".yaml"))).toHaveLength(2);
      const nextCard = await readFile(secondBody.evidenceCards[0].path, "utf8");
      expect(nextCard).toContain('status: "proposed"');
      expect(nextCard).not.toContain("keep this reviewed decision");
    },
    TIMEOUT,
  );


  test(
    "anchors draft patches to the section matching the dominant failure stage",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const skillFile = join(root, "skills", "verify-skill", "SKILL.md");
      await mkdir(dirname(skillFile), { recursive: true });
      await writeFile(
        skillFile,
        [
          "---",
          "name: verify-skill",
          "description: fixture",
          "---",
          "",
          "# verify-skill",
          "",
          "## Setup",
          "",
          "Install dependencies.",
          "",
          "## Execution",
          "",
          "Run the command.",
          "",
          "## Verification",
          "",
          "Run tests.",
          "",
          "## Common Pitfalls",
          "",
          "Avoid stale caches.",
          "",
        ].join("\n"),
        "utf8",
      );
      const events = [
        skillResultEvent(1, skillFile, "failed", "verify-skill", "verify", "TimeoutError"),
        skillResultEvent(2, skillFile, "failed", "verify-skill", "verify", "TimeoutError"),
        skillResultEvent(3, skillFile, "failed", "verify-skill", "verify", "TimeoutError"),
        skillResultEvent(4, skillFile, "failed", "verify-skill", "verify", "TimeoutError"),
        skillResultEvent(5, skillFile, "succeeded", "verify-skill"),
      ];
      const ingest = runMemory(["event", "skill", "--root", root], events.map((event) => JSON.stringify(event)).join("\n"));
      expect(ingest.status).toBe(0);

      const result = runMemory(["improve", "skills", "--root", root, "--write-proposal", "--json"]);
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout);
      const proposal = await readFile(body.proposals[0].path, "utf8");
      const block = proposal.match(/```json memory-skill-patch\s*([\s\S]*?)```/);
      expect(block).not.toBeNull();
      const patch = JSON.parse(block![1]);
      expect(patch.oldString).toContain("## Verification\n\nRun tests.");
      expect(patch.oldString).not.toContain("## Common Pitfalls");
      expect(patch.newString).toContain("Dominant error class: TimeoutError");
      expect(patch.newString).toContain("verification guidance for the `verify` stage");
    },
    TIMEOUT,
  );

});
