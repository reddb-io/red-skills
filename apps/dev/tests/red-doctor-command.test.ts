import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRegistrationState } from "../src/runtime/redskilled-birth.js";

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

const listLabelNames = vi.fn(async () => ({
  names: ["bug", "ready-for-agent", "wayfinder:map", "wayfinder:grilling", "wayfinder:prototype"],
}));

const projectRegistrationState = vi.fn<() => Promise<ProjectRegistrationState>>(async () => ({
  held: null,
  lapse: null,
  birthLatch: null,
}));

const collectPrecheckFacts = vi.fn(async () => ({}));

vi.mock("../src/runtime/redskilled-birth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime/redskilled-birth.js")>()),
  createRedskilledBirthPort: () => ({ registrationState: projectRegistrationState }),
}));

// A repo whose `req:N` labels and native blocked-by edges disagree in one
// direction, so the wired ADR 0094 audit (check 15) has something to report.
const listDependencyEdgeTickets = vi.fn(async () => ({
  tickets: [{ number: 2501, labels: ["req:2400"], nativeBlockedBy: [] }],
  unread: [],
}));

vi.mock("../src/runtime/gh.js", () => ({
  editBody: vi.fn(async () => true),
  listCandidates,
  listDependencyEdgeTickets,
  listIssueStates: vi.fn(async () => new Map()),
  listLabelNames,
  postClaimComment: vi.fn(async () => 1),
}));

vi.mock("../src/runtime/wire.js", () => ({
  afkPaths: (root: string) => ({ tmpDir: join(root, ".red/tmp") }),
  collectPrecheckFacts,
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

  it("renders Validation declaration/engine drift from project config", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-validation-moments-"));
    roots.push(root);
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "    afk:",
      "      validation:",
      "        correction:",
      "          - pnpm test",
      "",
    ].join("\n"));
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    expect(collectPrecheckFacts).toHaveBeenCalledWith(
      expect.objectContaining({ root }),
      expect.objectContaining({ includeLaneCensus: true }),
    );

    const output = writes.join("");
    expect(output).toContain("red-doctor Validation declaration vs engine");
    expect(output).toContain("verdict: drift");
    expect(output).toContain("unsupported-declaration correction");
    expect(output).toContain("afk.validation.correction is declared but the engine has no such Validation moment");
    stdout.mockRestore();
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

  it("finds a lapsed registration while the executable queue is non-empty", async () => {
    projectRegistrationState.mockResolvedValueOnce({
      held: null,
      birthLatch: null,
      lapse: {
        project_label: "acme/widgets",
        at: "2026-08-03T17:20:00.000Z",
        renew_by: "2026-08-03T17:19:59.000Z",
        renewals: 0,
        sustains: 0,
        detail: "nothing renewed it while ready-for-agent work remained",
      },
    });
    const root = await mkdtemp(join(tmpdir(), "red-doctor-registration-lapse-"));
    roots.push(root);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const output = writes.join("");
    expect(output).toContain("red-doctor project registration");
    expect(output).toContain("❌ lapsed-with-work");
    expect(output).toContain("2026-08-03T17:20:00.000Z");
    expect(output).toContain("ready-for-agent queue contains 1 item(s)");
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

// Seven classifiers the SKILL.md names were documented, unit-tested, and
// imported by nothing (#3034), so the doctor reported clean on dimensions it
// never examined. These pose the defects END-TO-END, through the command.
describe("redDoctorCommand — wired classifier checks", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function seedDefectiveRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "red-doctor-classifiers-"));
    roots.push(root);
    await mkdir(join(root, ".red", "tmp", "mystery-lane"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "posed", scripts: {} }), "utf8");
    await writeFile(
      join(root, ".red", "config.yaml"),
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      validation:",
        "        post_done:",
        "          - pnpm run gone",
        "      hooks:",
        "        pre_wrktree: echo typo",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(root, ".red", "tmp", "loose.txt"), "", "utf8");
    return root;
  }

  it("prints each newly wired check's documented finding in the human scorecard", async () => {
    const root = await seedDefectiveRepo();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    expect(human).toContain("red-doctor AFK hook / backpressure static validation");
    expect(human).toContain('error pnpm run gone: package.json has no script "gone"');
    expect(human).toContain("unknown hook name 'pre_wrktree'");
    expect(human).toContain("red-doctor per-plugin runtime distribution");
    expect(human).toContain("red-doctor required host binaries");
    expect(human).toContain("red-doctor native blocked-by vs req:N divergence");
    expect(human).toContain("#2501 has req:2400 label but no native blocked-by #2400 edge");
    expect(human).toContain("red-doctor ask-red router coverage sync");
    expect(human).toContain("red-doctor .red lifecycle taxonomy");
    expect(human).toContain("warn loose-tmp-file .red/tmp/loose.txt");
    expect(human).toContain("warn unknown-tmp-lane .red/tmp/mystery-lane");
    expect(human).toContain("red-doctor unlanded .red docs");
    stdout.mockRestore();
  });

  it("renders the same wired checks in the --json (TOON) form", async () => {
    const root = await seedDefectiveRepo();
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, "--json"], root)).resolves.toBe(0);

    const toon = writes.join("");
    for (const section of [
      "afkHooks",
      "pluginRuntime",
      "hostBinaries",
      "dependencyEdges",
      "askRedRouter",
      "redTaxonomy",
      "unlandedDocs",
    ]) {
      expect(toon).toContain(section);
    }
    expect(toon).toContain("req-label-without-native");
    expect(toon).toContain("unknown-tmp-lane");
    stdout.mockRestore();
  });

  it("stays read-only: the posed repo's config and tmp lane survive the pass", async () => {
    const root = await seedDefectiveRepo();
    const before = await readFile(join(root, ".red", "config.yaml"), "utf8");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    expect(await readFile(join(root, ".red", "config.yaml"), "utf8")).toBe(before);
    expect(await readFile(join(root, ".red", "tmp", "loose.txt"), "utf8")).toBe("");
    stdout.mockRestore();
  });
});

// The label half and the declaration half are one protection (#3013): a repo
// carrying `wayfinder:*` HUMAN-ONLY labels with no `afk.labels.hitl_types`
// entry LOOKS protected while every unblocked decision Ticket goes to the
// autonomous queue.
describe("redDoctorCommand — HUMAN-ONLY type declaration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function seedRoot(prefix: string, configText: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), configText, "utf8");
    return root;
  }

  it("flags an installed type label that no hitl_types entry declares, without writing", async () => {
    const config = "plugins:\n  dev:\n    enabled: true\n";
    const root = await seedRoot("red-doctor-hitl-types-", config);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    expect(human).toContain("red-doctor HUMAN-ONLY type declaration");
    expect(human).toContain("warn wayfinder:grilling");
    expect(human).toContain("warn wayfinder:prototype");
    expect(human).toContain("afk.labels.hitl_types");
    // Diagnose is read-only: the config is byte-identical.
    expect(await readFile(join(root, ".red", "config.yaml"), "utf8")).toBe(config);
    stdout.mockRestore();
  });

  it("merges the declaration under --fix --yes, keeping the operator's own entry", async () => {
    const root = await seedRoot(
      "red-doctor-hitl-types-fix-",
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      labels:",
        "        hitl_types:",
        "          - decision:grilling",
        "",
      ].join("\n"),
    );
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, "--fix", "--yes"], root)).resolves.toBe(0);

    const { parseConfigYaml } = await import("../src/core/config.js");
    const { declaredHitlTypeLabels } = await import("../src/core/hitl-type-declaration.js");
    const after = await readFile(join(root, ".red", "config.yaml"), "utf8");
    expect(declaredHitlTypeLabels(parseConfigYaml(after))).toEqual([
      "decision:grilling",
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
    expect(writes.join("")).toContain("fix hitl-type-declaration: applied");
    stdout.mockRestore();
  });

  it("leaves the config untouched when --fix runs without approval", async () => {
    const config = "plugins:\n  dev:\n    enabled: true\n";
    const root = await seedRoot("red-doctor-hitl-types-unapproved-", config);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, "--fix"], root)).resolves.toBe(0);

    expect(await readFile(join(root, ".red", "config.yaml"), "utf8")).toBe(config);
    expect(writes.join("")).toContain("fix hitl-type-declaration: declined");
    stdout.mockRestore();
  });

  it("reports an unreadable label list as an error rather than a clean pair", async () => {
    const root = await seedRoot("red-doctor-hitl-types-transport-", "plugins:\n  dev:\n    enabled: true\n");
    listLabelNames.mockResolvedValueOnce({ failure: "HTTP 403: SAML enforcement" } as never);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root], root)).resolves.toBe(0);

    const human = writes.join("");
    expect(human).toContain("label-list-unavailable");
    expect(human).toContain("SAML enforcement");
    stdout.mockRestore();
  });
});

// #3062: a plugin installed mid-session has its `.mcp.json` on disk and its
// server processes never started, and every surface of ours used to stay
// silent — so the agent forensically re-derived a one-line cure.
describe("redDoctorCommand — declared-but-unloaded MCP servers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function seedPluginRepo(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n", "utf8");
    await mkdir(join(root, "plugins", "dev"), { recursive: true });
    await writeFile(
      join(root, "plugins", "dev", ".mcp.json"),
      JSON.stringify({ mcpServers: { navigator: {}, redskilled: {}, rsp: {} } }),
      "utf8",
    );
    return root;
  }

  async function runDoctor(root: string, args: readonly string[]): Promise<string> {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { redDoctorCommand } = await import("../src/commands/red-doctor.js");

    await expect(redDoctorCommand(["--root", root, ...args], root)).resolves.toBe(0);

    stdout.mockRestore();
    return writes.join("");
  }

  it("flags a session that sees none of the declared servers, naming the reload cure", async () => {
    const root = await seedPluginRepo("red-doctor-mcp-load-none-");

    const human = await runDoctor(root, ["--session-mcp", "none"]);

    expect(human).toContain("red-doctor declared MCP servers loaded in this session");
    expect(human).toContain("❌ dev declared=navigator,redskilled,rsp");
    expect(human).toContain("error declared-unloaded");
    expect(human).toContain("installed or updated mid-session");
    expect(human).toContain("fix: restart the session, or run /reload-plugins");
  });

  it("passes clean when the session names the host-prefixed tools of every server", async () => {
    const root = await seedPluginRepo("red-doctor-mcp-load-ok-");

    const human = await runDoctor(root, [
      "--session-mcp",
      "mcp__plugin_dev_navigator__hover,mcp__plugin_dev_redskilled__project_status,mcp__plugin_dev_rsp__rsp_status",
    ]);

    expect(human).toContain("✅ dev declared=navigator,redskilled,rsp");
    expect(human).toContain("mcp load findings: 0");
  });

  // A run that was never told what the session sees is not a clean one.
  it("warns and names the flag when nobody stated the session", async () => {
    const root = await seedPluginRepo("red-doctor-mcp-load-unobserved-");

    const human = await runDoctor(root, []);

    expect(human).toContain("warn session-unobserved");
    expect(human).toContain("fix: re-run with --session-mcp");
  });

  it("renders the same check in the --json (TOON) form", async () => {
    const root = await seedPluginRepo("red-doctor-mcp-load-json-");

    const toon = await runDoctor(root, ["--json", "--session-mcp", ""]);

    expect(toon).toContain("mcpLoad");
    expect(toon).toContain("declared-unloaded");
  });
});
