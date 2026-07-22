import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const listCandidates = vi.fn(async () => [
  {
    number: 2403,
    title: "Lint executable tickets",
    body: `## Acceptance criteria

- [ ] The implementation passes review.
`,
    labels: ["ready-for-agent"],
  },
]);

vi.mock("../src/runtime/gh.js", () => ({
  editBody: vi.fn(async () => true),
  listCandidates,
  listIssueStates: vi.fn(async () => new Map()),
  postClaimComment: vi.fn(async () => 1),
}));

vi.mock("../src/runtime/wire.js", () => ({
  afkPaths: (root: string) => ({ tmpDir: join(root, ".red/tmp") }),
  collectPrecheckFacts: vi.fn(async () => ({})),
  resolveRepoContext: vi.fn(async (root: string) => ({ root, repo: "acme/widgets" })),
}));

vi.mock("../src/runtime/tmp-janitor.js", () => ({
  applyTmpJanitorReport: vi.fn(async () => ({
    expiredLanes: [],
    staleWorkers: [],
    unknownTmpRoots: [],
    protectedLiveWorkers: [],
  })),
  collectTmpJanitorReport: vi.fn(async () => ({
    plan: {
      logs: { reclaim: [] },
      scratch: { reclaim: [] },
      diagnostics: { reclaim: [] },
      feedbackWorktrees: { reclaim: [] },
      legacySlotLogs: { reclaim: [] },
      unknownTmpRoots: [],
    },
    staleWorkers: { reclaim: [] },
  })),
}));

vi.mock("../src/core/operational-probes.js", () => ({
  applyOperationalProbeFixes: vi.fn(async () => []),
  runOperationalProbes: vi.fn(async () => ({ probes: [], findings: [] })),
  terminateSupervisorPid: vi.fn(async () => undefined),
}));

vi.mock("../src/core/castle-state-doctor.js", () => ({
  auditCastleStateLane: vi.fn(async () => ({
    status: "ok",
    checked: { castleLanePresent: false, legacyLanePresent: false },
    findings: [],
  })),
}));

describe("redDoctorCommand — executable acceptance criteria lint", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("lists ready-for-agent candidates and reports acceptance lint findings read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-command-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    expect(listCandidates).toHaveBeenCalledWith(
      { cwd: root, repo: "acme/widgets" },
      "ready-for-agent",
      expect.objectContaining({ onTransportFailure: expect.any(Function) }),
    );
    const output = writes.join("");
    expect(output).toContain("red-doctor executable acceptance criteria");
    expect(output).toContain("warn #2403: acceptance criteria item is not machine-checkable");
    expect(output).toContain("fix: refresh ## Acceptance criteria");
    stdout.mockRestore();
  });
});
