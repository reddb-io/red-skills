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
    protectedLiveFeedback: [],
    workerWorkspaces: [],
    protectedLiveWorkspaces: [],
    refusedOutsideTmp: [],
    removals: [],
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
    workerReclaim: {
      workers: [],
      reclaim: [],
      retain: [],
      dropped: [],
      truncated: false,
      totals: { considered: 0, reclaim: 0, retain: 0, dropped: 0 },
    },
  })),
}));

vi.mock("../src/core/operational-probes.js", () => ({
  applyOperationalProbeFixes: vi.fn(async () => []),
  runOperationalProbes: vi.fn(async () => ({ probes: [], findings: [] })),
  terminateSupervisorPid: vi.fn(async () => undefined),
}));

const deadendReport = {
  generatedAtMs: 1_700_000_000_000,
  total: 1,
  classes: [
    {
      deadendClass: "dangling_claim",
      cure: "claim_release",
      count: 1,
      findings: [
        { deadendClass: "dangling_claim", cure: "claim_release", subject: "#100", detail: "claim held by dead worker wDEAD" },
      ],
    },
  ],
};

vi.mock("../src/runtime/deadend-audit-report.js", () => ({
  collectDeadendAuditReport: vi.fn(async () => deadendReport),
}));

// The host under test may or may not have a daemon, so the FACTS are posed and
// the real audit runs over them: what is being checked is that the doctor
// reports provisioning and prints what to run, not what this machine happens to
// have installed.
vi.mock("@reddb-io/redskilled/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reddb-io/redskilled/provision")>()),
  readRedskilledProvisionFacts: vi.fn(async () => ({
    homePath: "/home/dev/.red/redskilled",
    homePresent: false,
    homeMode: undefined,
    // A machine whose project declares the `host` preset, so the absent home is
    // a real defect rather than the ordinary shape of a `local` one (#2958).
    homeNeed: { needed: true, declaredBy: "plugins.dev.workspace.target: host (/repo/.red/config.yaml)" },
    entry: { command: "/usr/bin/node", args: ["/bundles/redskilled.bundle.min.mjs"], source: "bundle-cache" as const },
    socketPath: "/run/user/1000/red-skills/redskilled.sock",
    reachable: false,
    supervisorUnit: "absent" as const,
  })),
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

  it("renders the same read-only deadend audit with each class cure", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-deadend-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    expect(human).toContain("red-doctor deadend audit");
    expect(human).toContain("deadends: 1");
    expect(human).toContain("dangling_claim #100 → cure: claim_release");
    stdout.mockRestore();
  });

  it("reports an unprovisioned daemon and names what to run", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-redskilled-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    expect(human).toContain("red-doctor redskilled daemon");
    expect(human).toContain("provisioning: missing");
    expect(human).toContain("/home/dev/.red/redskilled does not exist, and it is needed");
    expect(human).toContain("no daemon answered on /run/user/1000/red-skills/redskilled.sock");
    expect(human).toContain("fix: run `/red-setup`");
    expect(human).toContain("redskilled provision");
    stdout.mockRestore();
  });

  it("reads an absent home as ok when this project's preset never reads it", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-redskilled-unneeded-"));
    roots.push(root);
    const { readRedskilledProvisionFacts } = await import("@reddb-io/redskilled/provision");
    vi.mocked(readRedskilledProvisionFacts).mockResolvedValueOnce({
      homePath: "/home/dev/.red/redskilled",
      homePresent: false,
      homeMode: undefined,
      homeNeed: { needed: false, declaredBy: "/repo/.red/config.yaml declares no workspace target (default local)" },
      entry: { command: "/usr/bin/node", args: ["/bundles/redskilled.bundle.min.mjs"], source: "bundle-cache" },
      socketPath: "/run/user/1000/red-skills/redskilled.sock",
      reachable: true,
      supervisorUnit: "absent",
    });
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    // A daemon that answers on a machine with no home is a fully provisioned
    // host: the doctor must not send its operator after a directory nothing reads.
    expect(human).toContain("provisioning: ok");
    expect(human).toContain("absent and unneeded");
    expect(human).not.toContain("fix: run `/red-setup`");
    stdout.mockRestore();
  });

  it("renders the redskilled provisioning verdict in the --json (TOON) form", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-redskilled-json-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, "--json"], root)).resolves.toBe(0);

    const toon = writes.join("");
    expect(toon).toContain("redskilled");
    expect(toon).toContain("supervisor-unit");
    stdout.mockRestore();
  });

  it("renders the deadend audit in the --json (TOON) form", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-deadend-json-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, "--json"], root)).resolves.toBe(0);

    const toon = writes.join("");
    expect(toon).toContain("deadendAudit");
    expect(toon).toContain("claim_release");
    stdout.mockRestore();
  });
});
