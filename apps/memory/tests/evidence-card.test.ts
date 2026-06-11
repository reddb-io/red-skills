import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EVIDENCE_CARD_CONTRACT,
  createEvidenceCard,
  evidenceInboxRoot,
  formatEvidenceCardYaml,
  parseEvidenceCardYaml,
  validateEvidenceCard,
} from "../src/evidence-card.js";

const TIMEOUT = 90_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-evidence-card-"));
  roots.push(root);
  return root;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function cardInput(overrides = {}) {
  return {
    source: {
      kind: "issue",
      ref: "https://github.com/reddb-io/red-skills/issues/545",
      collected_at: "2026-06-08T02:51:07.234Z",
    },
    summary: "Evidence cards are reviewed before becoming durable Memory facts.",
    citations: [
      {
        label: "issue 545",
        uri: "https://github.com/reddb-io/red-skills/issues/545",
        quote: "Evidence cards persist as YAML.",
      },
    ],
    proposedLesson: {
      text: "Keep evidence review metadata separate from proposal apply state.",
      scope: "project",
    },
    route: {
      target: "memory",
      rationale: "candidate durable lesson",
    },
    confidence: "EXTRACTED" as const,
    blastRadius: {
      scope: "project",
      rationale: "Memory maintainers review before promotion.",
    },
    privacyNotes: ["review privacy findings before approval"],
    judge: {
      score: 0.82,
      rationale: "Directly backed by acceptance criteria.",
    },
    proposalLink: {
      kind: "skill-improvement",
      path: ".red/memory/proposals/pending.md",
      apply_state: "pending" as const,
    },
    ...overrides,
  };
}

describe("Evidence card YAML contract", () => {
  test("writes and parses YAML cards from the Evidence inbox", async () => {
    const root = await tempRoot();
    const card = await createEvidenceCard(root, cardInput(), new Date("2026-06-08T03:00:00.000Z"));

    const files = await readdir(evidenceInboxRoot(root));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${card.id}.yaml`);
    expect(files[0]?.endsWith(".json")).toBe(false);

    const raw = await readFile(join(evidenceInboxRoot(root), files[0]), "utf8");
    expect(raw).toContain(`contract: ${EVIDENCE_CARD_CONTRACT}`);
    expect(raw).toContain("proposal_link:");

    const parsed = parseEvidenceCardYaml(raw);
    expect(parsed).toEqual(card);

    const roundTrip = parseEvidenceCardYaml(formatEvidenceCardYaml(card));
    expect(roundTrip).toEqual(card);

    const otherRoot = await tempRoot();
    const sameEvidence = await createEvidenceCard(otherRoot, cardInput(), new Date("2026-06-08T04:00:00.000Z"));
    expect(sameEvidence.id).toBe(card.id);
  });

  test("reports validation failures for missing required contract fields", () => {
    expect(() =>
      validateEvidenceCard({
        contract: EVIDENCE_CARD_CONTRACT,
        id: "evidence-123456789abc",
        status: "pending",
      }),
    ).toThrow(/source/);
    expect(() => parseEvidenceCardYaml("---\ncontract: memory.evidence_card.experimental.v0\n---\n")).toThrow(
      /invalid Evidence card/,
    );
  });

  test("redacts sensitive text before persistence while keeping privacy findings reviewable", async () => {
    const root = await tempRoot();
    const token = "sk-test_1234567890abcdefghijklmnopqrstuv";
    const card = await createEvidenceCard(
      root,
      cardInput({
        summary: `The leaked deployment token was ${token}.`,
        citations: [{ label: "stop hook", quote: `transcript included ${token}` }],
        proposedLesson: { text: `Never store ${token} as Memory evidence.` },
      }),
      new Date("2026-06-08T03:10:00.000Z"),
    );

    const raw = await readFile(join(evidenceInboxRoot(root), `${card.id}.yaml`), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain("[REDACTED:openai-token]");
    expect(card.privacy.redacted).toBe(true);
    expect(card.privacy.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "openai-token" })]),
    );
  });
});

describe("memory evidence CLI", () => {
  test("lists, shows, approves, and rejects YAML cards without promoting graph facts", async () => {
    const root = await tempRoot();
    expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);

    const createApproved = runMemory([
      "evidence",
      "create",
      "--root",
      root,
      "--summary",
      "Evidence review approves a card without applying linked proposals.",
      "--source-ref",
      "issue 545",
      "--citation",
      "issue 545|https://github.com/reddb-io/red-skills/issues/545|approve and reject cards",
      "--lesson",
      "Approval updates card review state only.",
      "--route",
      "memory",
      "--confidence",
      "EXTRACTED",
      "--blast-radius",
      "project",
      "--judge-score",
      "0.9",
      "--judge-reason",
      "Acceptance criteria explicitly require this behavior.",
      "--proposal-kind",
      "skill-improvement",
      "--proposal-path",
      ".red/memory/proposals/pending.md",
      "--proposal-apply-state",
      "pending",
      "--json",
    ]);
    expect(createApproved.status, createApproved.stderr).toBe(0);
    const approvedId = (JSON.parse(createApproved.stdout) as { card: { id: string } }).card.id;

    const createRejected = runMemory([
      "evidence",
      "create",
      "--root",
      root,
      "--summary",
      "Temporary task progress should not become a lesson.",
      "--source-ref",
      "agent log",
      "--citation",
      "agent log||tests are still running",
      "--lesson",
      "Ignore temporary progress updates.",
      "--json",
    ]);
    expect(createRejected.status, createRejected.stderr).toBe(0);
    const rejectedId = (JSON.parse(createRejected.stdout) as { card: { id: string } }).card.id;

    const listed = runMemory(["evidence", "list", "--root", root, "--json"]);
    expect(listed.status, listed.stderr).toBe(0);
    expect((JSON.parse(listed.stdout) as { cards: unknown[] }).cards).toHaveLength(2);

    const shown = runMemory(["evidence", "show", approvedId, "--root", root]);
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`memory evidence: ${approvedId}`);
    expect(shown.stdout).toContain(`contract: ${EVIDENCE_CARD_CONTRACT}`);
    expect(shown.stdout).toContain("proposal: skill-improvement apply_state=pending");

    const approve = runMemory([
      "evidence",
      "approve",
      approvedId,
      "--root",
      root,
      "--reviewer",
      "maintainer",
      "--yes",
      "--json",
    ]);
    expect(approve.status, approve.stderr).toBe(0);
    const approved = JSON.parse(approve.stdout) as {
      card: { status: string; review: { state: string; reviewer: string }; proposal_link: { apply_state: string } };
    };
    expect(approved.card.status).toBe("approved");
    expect(approved.card.review).toMatchObject({ state: "approved", reviewer: "maintainer" });
    expect(approved.card.proposal_link.apply_state).toBe("pending");

    const reject = runMemory([
      "evidence",
      "reject",
      rejectedId,
      "--root",
      root,
      "--reason",
      "not durable",
      "--reviewer",
      "maintainer",
      "--yes",
      "--json",
    ]);
    expect(reject.status, reject.stderr).toBe(0);
    const rejected = JSON.parse(reject.stdout) as { card: { status: string; review: { state: string; reason: string } } };
    expect(rejected.card.status).toBe("rejected");
    expect(rejected.card.review).toMatchObject({ state: "rejected", reason: "not durable" });

    const stats = runMemory(["stats", "--root", root]);
    expect(stats.status, stats.stderr).toBe(0);
    expect(stats.stdout).toContain("memory: 0 node(s), 0 edge(s)");

    const files = await readdir(evidenceInboxRoot(root));
    expect(files.sort()).toEqual([`${approvedId}.yaml`, `${rejectedId}.yaml`].sort());
  }, TIMEOUT);

  test("reviews linked proposal cards without applying or archiving proposals", async () => {
    const root = await tempRoot();
    expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);
    const proposalDir = join(root, ".red", "memory", "proposals");
    await mkdir(proposalDir, { recursive: true });
    const approvedProposal = join(proposalDir, "approve-linked.md");
    const rejectedProposal = join(proposalDir, "reject-linked.md");
    await writeFile(approvedProposal, "# Skill Improvement Proposal: approve\n\nPatch later.\n", "utf8");
    await writeFile(rejectedProposal, "# Skill Improvement Proposal: reject\n\nPatch later.\n", "utf8");

    const createApproved = runMemory([
      "evidence",
      "create",
      "--root",
      root,
      "--summary",
      "Approving a linked Evidence card validates only the evidence interpretation.",
      "--source-ref",
      "issue 549",
      "--citation",
      "issue 549||approve linked card",
      "--lesson",
      "Keep linked proposal application separate from card approval.",
      "--proposal-kind",
      "skill-improvement",
      "--proposal-path",
      ".red/memory/proposals/approve-linked.md",
      "--proposal-apply-state",
      "pending",
      "--json",
    ]);
    expect(createApproved.status, createApproved.stderr).toBe(0);
    const approvedId = (JSON.parse(createApproved.stdout) as { card: { id: string } }).card.id;
    const beforeApprove = await readFile(approvedProposal, "utf8");
    const approve = runMemory(["evidence", "approve", approvedId, "--root", root, "--reviewer", "maintainer", "--yes", "--json"]);
    expect(approve.status, approve.stderr).toBe(0);
    expect(await readFile(approvedProposal, "utf8")).toBe(beforeApprove);
    const approvedCardBody = await readFile(join(evidenceInboxRoot(root), `${approvedId}.yaml`), "utf8");
    expect(approvedCardBody).toContain("status: approved");
    expect(approvedCardBody).toContain("state: approved");

    const createRejected = runMemory([
      "evidence",
      "create",
      "--root",
      root,
      "--summary",
      "Rejecting a linked Evidence card warns the linked proposal only.",
      "--source-ref",
      "issue 549",
      "--citation",
      "issue 549||reject linked card",
      "--lesson",
      "Warn when evidence interpretation is rejected.",
      "--proposal-kind",
      "skill-improvement",
      "--proposal-path",
      ".red/memory/proposals/reject-linked.md",
      "--proposal-apply-state",
      "pending",
      "--json",
    ]);
    expect(createRejected.status, createRejected.stderr).toBe(0);
    const rejectedId = (JSON.parse(createRejected.stdout) as { card: { id: string } }).card.id;
    const reject = runMemory([
      "evidence",
      "reject",
      rejectedId,
      "--root",
      root,
      "--reason",
      "evidence interpretation was wrong for token sk-test_1234567890abcdefghijklmnopqrstuv",
      "--reviewer",
      "maintainer",
      "--yes",
      "--json",
    ]);
    expect(reject.status, reject.stderr).toBe(0);
    const rejectedCardBody = await readFile(join(evidenceInboxRoot(root), `${rejectedId}.yaml`), "utf8");
    expect(rejectedCardBody).toContain("status: rejected");
    expect(rejectedCardBody).toContain("state: rejected");
    const rejectedProposalBody = await readFile(rejectedProposal, "utf8");
    expect(rejectedProposalBody).toContain("## Evidence Card Review Warning");
    expect(rejectedProposalBody).toContain(`Evidence card id: ${rejectedId}`);
    expect(rejectedProposalBody).toContain("evidence interpretation was wrong for token [REDACTED:openai-token]");
    expect((await readdir(proposalDir)).sort()).toEqual(["approve-linked.md", "reject-linked.md"].sort());

    const v1RejectedId = "skill-card-549-rejected";
    const v1RejectedCard = join(evidenceInboxRoot(root), `${v1RejectedId}.yaml`);
    await writeFile(
      v1RejectedCard,
      [
        'contract: "memory.evidence-card.experimental.v1"',
        `id: "${v1RejectedId}"`,
        'status: "proposed"',
        'updated_at: "2026-01-01T00:00:00.000Z"',
        "review:",
        "  decision: null",
        "proposal:",
        '  path: ".red/memory/proposals/reject-linked.md"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(rejectedProposal, "# Skill Improvement Proposal: reject\n\nPatch later.\n", "utf8");
    const rejectV1 = runMemory([
      "evidence",
      "reject",
      v1RejectedId,
      "--root",
      root,
      "--reason",
      "evidence interpretation was wrong for token sk-test_1234567890abcdefghijklmnopqrstuv",
      "--reviewer",
      "maintainer",
      "--yes",
      "--json",
    ]);
    expect(rejectV1.status, rejectV1.stderr).toBe(0);
    const rejectedV1CardBody = await readFile(v1RejectedCard, "utf8");
    expect(rejectedV1CardBody).toContain('status: "rejected"');
    expect(rejectedV1CardBody).toContain('decision: "rejected"');
    expect(rejectedV1CardBody).toContain('notes: "evidence interpretation was wrong for token [REDACTED:openai-token]"');

    await writeFile(rejectedProposal, "# Skill Improvement Proposal: reject\n\nPatch later.\n", "utf8");
    const rejectAgain = runMemory([
      "evidence",
      "reject",
      v1RejectedId,
      "--root",
      root,
      "--reason",
      "evidence interpretation was still wrong",
      "--reviewer",
      "maintainer",
      "--yes",
      "--json",
    ]);
    expect(rejectAgain.status, rejectAgain.stderr).toBe(0);
    const retriedProposalBody = await readFile(rejectedProposal, "utf8");
    expect(retriedProposalBody).toContain("## Evidence Card Review Warning");
    expect(retriedProposalBody).toContain(`Evidence card id: ${v1RejectedId}`);
    expect(retriedProposalBody).toContain("evidence interpretation was wrong for token [REDACTED:openai-token]");
    expect(retriedProposalBody).not.toContain("evidence interpretation was still wrong");

    const applyWithoutApproval = runMemory(["improve", "apply", rejectedProposal, "--root", root, "--json"]);
    expect(applyWithoutApproval.status).not.toBe(0);
    expect(applyWithoutApproval.stderr).toContain("requires explicit --yes approval");
    const applyWithoutStructuredBlock = runMemory(["improve", "apply", rejectedProposal, "--root", root, "--yes", "--json"]);
    expect(applyWithoutStructuredBlock.status).not.toBe(0);
    expect(applyWithoutStructuredBlock.stderr).toContain("structured memory-skill-patch block");
  }, TIMEOUT);
});
