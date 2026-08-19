/**
 * The extinction ratchet: a reader that reintroduces a Fleet or Attempt source
 * fails here, and so does a module or symbol merely NAMED for one (issue #2795,
 * issue #2850, Spec #2772, ADR 0130).
 *
 * Deleting the code was the crossing; this keeps it deleted. That migration is
 * over — no ADR 0130 location is tolerated — which is what promoted the ratchet
 * into the normal check set. Four properties are load-bearing: a new reference
 * FAILS and names its location, a NAME fails the same way a source does,
 * findings only ever DECREASE, and prose describing what was removed is
 * documentation rather than a reader.
 *
 * A SECOND crossing now rides the same ratchet — the execution chain of ADRs
 * 0147/0148/0149 (Spec #4007, issue #4009) — declared at today's counts BEFORE
 * its surfaces are deleted. Its own describe block is at the foot of this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExtinctSourceFindings,
  collectExtinctSourceFindingsFromFiles,
  extinctSourceCrossingComplete,
  formatExtinctSourceFailureMessage,
  formatExtinctSourceViolations,
  readExtinctSourceFiles,
  EXTINCT_NAMES,
  EXTINCT_SOURCES,
  EXTINCT_SOURCE_BASELINE,
  EXTINCT_SOURCE_BASELINE_DECLARATION,
  stripComments,
  EXTINCT_INVENTORY_PATHS,
  type ExtinctSourceBaselineEntry,
} from "../src/core/extinct-source-guard.js";
import {
  EXECUTION_CHAIN_BASELINE,
  EXECUTION_CHAIN_NAMES,
  EXECUTION_CHAIN_SOURCES,
} from "../src/core/extinct-execution-chain.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A file that reads the extinct named-fleet registry — the shape ADR 0130 removed. */
const FLEET_READER = `
  import { readFleetProfiles } from "@reddb-io/red-castle/engine";

  export async function attributeWorker(root: string, name: string) {
    const profiles = await readFleetProfiles(root + "/.red/state/castle/fleets.toonl");
    return profiles.find((profile) => profile.name === name);
  }
`;

/** A file that reads the extinct attempt record. */
const ATTEMPT_READER = `
  import { readCastleAttemptRecords } from "@reddb-io/red-castle/engine";

  export async function lastTry(root: string, worker: string) {
    const records = await readCastleAttemptRecords(root);
    return records.find((record) => record.worker_id === worker);
  }
`;

/**
 * THE FIXTURE THAT PROVES THE NAME DIMENSION (#2850): the supervisor's
 * `attempt-accounting.ts` as it stood before this slice removed it. It imports
 * nothing extinct and reads no removed lane, so the source dimension saw a clean
 * file — the leftover was the ATTEMPT-KEYED IDENTITY in the module's own name and
 * in its exports. Kept verbatim in shape so a future edit to the name inventory
 * is checked against the real leftover rather than against a toy.
 */
const ATTEMPT_ACCOUNTING_LEFTOVER = `
  import {
    evaluateAttemptBudgets,
    type AttemptBudgetBreach,
    type AttemptBudgets,
    type AttemptUsage,
  } from "../attempt-budget.js";
  import type { SlotState, SupervisorState } from "./state.js";

  export function attemptUsage(slot: SlotState, info: IterDirInfo | null): AttemptUsage {
    return { ...(slot.peakRssMb > 0 ? { peakRssMb: slot.peakRssMb } : {}) };
  }

  export function resourceBudgetBreach(
    usage: AttemptUsage,
    budgets: AttemptBudgets,
  ): AttemptBudgetBreach | null {
    const { wall_clock_s: _wallClock, ...resourceBudgets } = budgets;
    return evaluateAttemptBudgets(usage, resourceBudgets);
  }

  export function sampleFleetPeakRss(state: SupervisorState): void {}
`;

describe("the live tree carries no fleet or attempt source (#2795)", () => {
  it("is green on the real apps/ and packages/ trees", () => {
    const findings = collectExtinctSourceFindings(ROOT);
    const violations = formatExtinctSourceViolations({ findings, baseline: EXTINCT_SOURCE_BASELINE });

    expect(violations, formatExtinctSourceFailureMessage(violations)).toEqual([]);
  });

  it("scanned the tree — a walker that reaches nothing is green by accident", () => {
    // The whole check is a scan, so a green verdict over zero files is the
    // failure mode that makes a ratchet decorative.
    const files = readExtinctSourceFiles(ROOT);

    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => file.relativePath === "apps/dev/src/core/repo-invariants.ts")).toBe(true);
    expect(files.some((file) => file.relativePath === "packages/red-castle/src/engine/paths.ts")).toBe(true);
  });

  it("carries no attempt-keyed accounting module at all (#2850)", () => {
    // The module is gone rather than tolerated: the scan sees every file under
    // `apps/` and `packages/`, so an absent basename is the whole claim.
    const files = readExtinctSourceFiles(ROOT);

    expect(files.filter((file) => /attempt-(?:accounting|budget)\./.test(file.relativePath))).toEqual([]);
    expect(files.some((file) => file.relativePath === "apps/dev/src/core/supervisor/worker-accounting.ts")).toBe(true);
    expect(files.some((file) => file.relativePath === "apps/dev/src/core/worker-budget.ts")).toBe(true);
  });
});

describe("a newly added source fails, naming the offending location (#2795)", () => {
  it("rejects reintroducing an expired status alias as an MCP tool", () => {
    const findings = collectExtinctSourceFindingsFromFiles([
      {
        relativePath: "packages/red-castle/src/mcp/legacy-status.ts",
        sourceText: `
export const tools = [
  { name: "worker_status", invoke: () => readWorkers() },
  { name: "worker_vitals", invoke: () => readVitals() },
  { name: "monitor", invoke: () => readMonitor() },
  { name: "host_state", invoke: () => readHost() },
];
`,
      },
    ]);

    expect(findings.filter((finding) => finding.sourceId === "deprecated-status-alias")).toHaveLength(4);
    const message = formatExtinctSourceFailureMessage(
      formatExtinctSourceViolations({ findings, baseline: [] }),
    );
    expect(message).toContain("status { scope: worker | project | host }");
  });

  it("names the file, line and column of a reintroduced fleet source", () => {
    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: "apps/dev/src/core/worker-attribution.ts", sourceText: FLEET_READER },
    ]);

    expect(findings.map((finding) => finding.sourceId)).toEqual(
      expect.arrayContaining(["fleet-registry", "fleet-registry-lane"]),
    );
    const violations = formatExtinctSourceViolations({ findings, baseline: [] });
    const message = formatExtinctSourceFailureMessage(violations);

    expect(message).toContain("apps/dev/src/core/worker-attribution.ts");
    expect(message).toContain("readFleetProfiles");
    expect(message).toContain("fleets.toonl");
    // The route, not only the refusal: the message says where a reader goes now.
    expect(message).toContain("project_start");
    expect(message).toContain(EXTINCT_SOURCE_BASELINE_DECLARATION);
    expect(findings[0]!.line).toBeGreaterThan(0);
    expect(findings[0]!.column).toBeGreaterThan(0);
  });

  it("names a reintroduced attempt source and the Worker that replaced it", () => {
    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: "packages/red-castle/src/engine/replay.ts", sourceText: ATTEMPT_READER },
    ]);
    const message = formatExtinctSourceFailureMessage(formatExtinctSourceViolations({ findings, baseline: [] }));

    // The fixture imports from `@reddb-io/red-castle/engine`, a specifier the
    // execution-chain crossing also names, so the attempt half is what is
    // asserted here rather than every finding the file produces.
    const attempt = findings.filter((finding) => finding.sourceId.startsWith("attempt-"));
    expect(attempt.length).toBeGreaterThan(0);
    expect(attempt.every((finding) => finding.noun === "attempt")).toBe(true);
    expect(message).toContain("packages/red-castle/src/engine/replay.ts");
    expect(message).toContain("liveness-anchor");
  });

  it("catches every declared source, so no entry is decorative", () => {
    // Each entry must actually match something: an inventory line whose pattern
    // can never fire is a hole that reads as coverage.
    for (const source of EXTINCT_SOURCES) {
      const probe = probeTextFor(source.id);
      const findings = collectExtinctSourceFindingsFromFiles(
        [{ relativePath: "apps/probe/src/probe.ts", sourceText: probe }],
        [source],
      );
      expect(findings, `${source.id} matched nothing in ${probe}`).not.toEqual([]);
    }
  });

  it("exempts only its own inventory, and only by exact path", () => {
    const inventory = readFileSync(join(ROOT, "apps/dev/src/core/extinct-source-guard.ts"), "utf8");

    // The declaration itself names every extinct identifier; scanned as any other
    // file it would red the ratchet forever.
    expect(collectExtinctSourceFindingsFromFiles([
      { relativePath: "apps/dev/src/core/extinct-source-guard.ts", sourceText: inventory },
    ])).toEqual([]);
    // Copied to any other path, the same text is a reader again — the exemption
    // cannot be widened by moving code into a friend module.
    expect(collectExtinctSourceFindingsFromFiles([
      { relativePath: "apps/dev/src/core/extinct-source-guard.copy.ts", sourceText: inventory },
    ])).not.toEqual([]);
  });
});

describe("a module named for an extinct concept fails, not only a reintroduced source (#2850)", () => {
  const PATH = "apps/dev/src/core/supervisor/attempt-accounting.ts";

  it("would have failed the leftover the source dimension could not see", () => {
    // The two dimensions are independent: with the name inventory switched off,
    // this file is GREEN — which is exactly how it survived ADR 0130.
    const sourceOnly = collectExtinctSourceFindingsFromFiles(
      [{ relativePath: PATH, sourceText: ATTEMPT_ACCOUNTING_LEFTOVER }],
      EXTINCT_SOURCES,
      [],
    );
    expect(sourceOnly).toEqual([]);

    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: PATH, sourceText: ATTEMPT_ACCOUNTING_LEFTOVER },
    ]);
    expect(findings.every((finding) => finding.sourceId.endsWith("-keyed-accounting"))).toBe(true);
    expect(findings.map((finding) => finding.kind)).toContain("module-name");
    expect(findings.map((finding) => finding.kind)).toContain("symbol-name");
  });

  it("names the module by its own filename, and the symbols it carried", () => {
    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: PATH, sourceText: ATTEMPT_ACCOUNTING_LEFTOVER },
    ]);
    const message = formatExtinctSourceFailureMessage(
      formatExtinctSourceViolations({ findings, baseline: [] }),
    );

    // The filename is the finding a text scan can never produce, so it is named
    // first — at line 1, where a reader opens the file.
    const moduleFinding = findings.find((finding) => finding.kind === "module-name");
    expect(moduleFinding).toMatchObject({ match: "attempt-accounting", line: 1, column: 1 });
    expect(message).toContain("module named for extinct concept");
    expect(message).toContain("attemptUsage");
    expect(message).toContain("AttemptBudgets");
    expect(message).toContain("sampleFleetPeakRss");
    // The route, not only the refusal: the message says what to rename onto.
    expect(message).toContain("worker-accounting.ts");
    expect(message).toContain("sampleWorkerPeakRss");
  });

  it("clears once the accounting is keyed to the Worker", () => {
    const renamed = ATTEMPT_ACCOUNTING_LEFTOVER.replace(/attempt-budget/g, "worker-budget")
      .replace(/AttemptBudget/g, "WorkerBudget")
      .replace(/AttemptUsage/g, "WorkerUsage")
      .replace(/attemptUsage/g, "workerUsage")
      .replace(/sampleFleetPeakRss/g, "sampleWorkerPeakRss");

    expect(
      collectExtinctSourceFindingsFromFiles([
        { relativePath: "apps/dev/src/core/supervisor/worker-accounting.ts", sourceText: renamed },
      ]),
    ).toEqual([]);
  });

  it("catches every declared name, so no entry is decorative", () => {
    for (const name of EXTINCT_NAMES) {
      const probe = nameProbeFor(name.id);
      const findings = collectExtinctSourceFindingsFromFiles(
        [{ relativePath: "apps/probe/src/probe.ts", sourceText: probe }],
        [],
        [name],
      );
      expect(findings, `${name.id} matched nothing in ${probe}`).not.toEqual([]);
    }
  });

  it("leaves the published operator contract alone", () => {
    // The `afk.attempt.budget.*` keys and the `RED_AFK_ATTEMPT_*` env overrides
    // are what an operator already wrote in `.red/config.yaml`. Renaming a key is
    // a breaking change of its own, so a dotted key is not a name being carried.
    const source = [
      `export const KEYS = { peak_rss_mb: "afk.attempt.budget.peak_rss_mb" };`,
      `export const ENV = { peak_rss_mb: "RED_AFK_ATTEMPT_PEAK_RSS_MB" };`,
      `export const MARKER = "🤖 /afk attempt budget";`,
      `export const HELP = FLEET_USAGE;`,
    ].join("\n");

    expect(collectExtinctSourceFindingsFromFiles([{ relativePath: "apps/dev/src/core/x.ts", sourceText: source }]))
      .toEqual([]);
  });
});

describe("the retired per-project supervisor loop stays extinct (#3161)", () => {
  it.each(["superviseTick", "runSupervisor"])("rejects the retired %s symbol", (symbol) => {
    const findings = collectExtinctSourceFindingsFromFiles([
      {
        relativePath: "apps/dev/src/core/project-loop.ts",
        sourceText: `export async function ${symbol}(): Promise<void> {}`,
      },
    ]);

    expect(findings.map((finding) => finding.match)).toContain(symbol);
    expect(findings.every((finding) => finding.noun === "supervisor")).toBe(true);
  });
});

describe("findings only decrease (#2795)", () => {
  const path = "apps/dev/src/core/worker-attribution.ts";
  const findings = collectExtinctSourceFindingsFromFiles([{ relativePath: path, sourceText: FLEET_READER }]);
  const registryFindings = findings.filter((finding) => finding.sourceId === "fleet-registry");
  const key = `fleet-registry:${path}`;

  it("tolerates exactly the declared count at a declared location", () => {
    const baseline: ExtinctSourceBaselineEntry[] = [
      { id: key, count: registryFindings.length, reason: "cleared by the crossing slice" },
    ];

    expect(formatExtinctSourceViolations({ findings: registryFindings, baseline })).toEqual([]);
  });

  it("fails the surplus when a location gains a reference", () => {
    const baseline: ExtinctSourceBaselineEntry[] = [
      { id: key, count: registryFindings.length - 1, reason: "one reference left" },
    ];

    // The increase — not the location — is what fails, and the surplus is named.
    const violations = formatExtinctSourceViolations({ findings: registryFindings, baseline });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(path);
  });

  it("stays green when a declared location clears entirely", () => {
    // A stale entry is the GOAL of the crossing, never a violation of it.
    const baseline: ExtinctSourceBaselineEntry[] = [
      { id: key, count: 3, reason: "already cleared by an earlier slice" },
    ];

    expect(formatExtinctSourceViolations({ findings: [], baseline })).toEqual([]);
  });

  it("refuses a baseline entry that declares no count or no reason", () => {
    const violations = formatExtinctSourceViolations({
      findings: [],
      baseline: [
        { id: key, count: 0, reason: "zero tolerates nothing, so it is a lie about the crossing" },
        { id: key, count: 1, reason: "  " },
      ],
    });

    expect(violations).toEqual([
      expect.stringContaining("positive integer count"),
      expect.stringContaining("duplicate baseline id"),
      expect.stringContaining("one-line reason"),
    ]);
  });
});

describe("prose is not a reader (#2795)", () => {
  it("ignores a comment that names what was removed", () => {
    const source = `
      // fleet-registry is gone (ADR 0130): readFleetProfiles answered nothing.
      /* The attempts.toonl lane and red.castle.attempt.v1 went with it. */
      export const PROJECT_SUPERVISOR_LANE = "default";
    `;

    expect(collectExtinctSourceFindingsFromFiles([{ relativePath: "apps/dev/src/core/x.ts", sourceText: source }]))
      .toEqual([]);
  });

  it("still catches a lane name or tool name inside a literal", () => {
    const source = `export const LANE = join(root, "attempts.toonl");\nexport const TOOL = "fleet_create";`;
    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: "apps/dev/src/core/x.ts", sourceText: source },
    ]);

    expect(findings.map((finding) => finding.sourceId).sort()).toEqual(["attempt-lane", "fleet-mcp-tools"]);
  });

  it("keeps a comment's line and column honest for the code beside it", () => {
    const source = `const a = 1; // fleet-registry\nconst b = readFleetProfiles();\n`;
    const [finding] = collectExtinctSourceFindingsFromFiles([
      { relativePath: "apps/dev/src/core/x.ts", sourceText: source },
    ]);

    expect(finding).toMatchObject({ line: 2, column: 11 });
  });

  it("does not treat a URL or a comment marker inside a string as a comment", () => {
    // Blanking from `//` in `"https://…"` would hide every match after it on
    // that line — a silent hole exactly where a path literal lives.
    const stripped = stripComments(`const u = "https://x/attempts.toonl"; // note\n`);
    expect(stripped).toContain("attempts.toonl");
    expect(stripped).not.toContain("note");
    expect(stripped.split("\n")[0]!.length).toBe(`const u = "https://x/attempts.toonl"; // note`.length);
  });

  it("leaves the surviving vocabulary alone", () => {
    // The words did not go extinct — the sources did. `CastleAttemptStatus` is a
    // live envelope attribute, `RED_AFK_FLEET_SCOPE` is the placement kill-switch
    // of #2697, the work selector outlived the fleet that owned it, and an
    // ORDINARY retry of a push is an attempt in plain English, not the extinct
    // unit of work — which is why a name entry pairs the noun with what it owned
    // (#2850) rather than reddening the bare word.
    const source = [
      `import type { CastleAttemptStatus } from "./contracts/index.js";`,
      `export const FLEET_SCOPE_ENV = "RED_AFK_FLEET_SCOPE";`,
      `export const MEMORY_HIGH_ENV = "RED_AFK_FLEET_SCOPE_MEMORY_HIGH";`,
      `export function readWorkSelector(value: unknown): WorkSelector { return parseWorkSelector(value); }`,
      `export const lane = paths.projectSupervisor;`,
      `export async function pushAttempt(branch: string): Promise<void> {}`,
      `export const MERGE_DRIVER_MAX_ATTEMPTS = 25;`,
    ].join("\n");

    expect(collectExtinctSourceFindingsFromFiles([{ relativePath: "apps/dev/src/core/x.ts", sourceText: source }]))
      .toEqual([]);
  });
});

describe("promoted into the normal check set (#2795)", () => {
  it("is declared as a repo-wide invariant, so a cone-scoped gate runs it", () => {
    const suite = REPO_INVARIANT_SUITES.find((entry) => entry.name === "invariants:extinct-nouns");

    expect(suite).toMatchObject({ scope: "apps/dev", script: "test:invariants" });
    expect(suite?.why).toContain("apps/");
  });

  it("is run by the script that invariant declaration names", () => {
    const manifest = readFileSync(join(ROOT, "apps/dev/package.json"), "utf8");
    const script = String(JSON.parse(manifest).scripts["test:invariants"]);

    expect(script).toContain("tests/extinct-source-guard.test.ts");
  });

  it("earned the promotion: the ADR 0130 crossing ran to zero, and stays there", () => {
    // The promotion is not handed back when a second crossing opens. Every
    // baseline id belongs to the execution chain, so no fleet, attempt or
    // supervisor location is tolerated anywhere in the tree.
    const chain = new Set([...EXECUTION_CHAIN_SOURCES, ...EXECUTION_CHAIN_NAMES].map((entry) => entry.id));
    const adr0130 = EXTINCT_SOURCE_BASELINE.filter((entry) => !chain.has(entry.id.split(":")[0]!));

    expect(adr0130, "an ADR 0130 location is tolerated again").toEqual([]);
    expect(extinctSourceCrossingComplete(adr0130)).toBe(true);
    // And the rule is executable rather than remembered: a non-empty baseline
    // means a crossing is still running.
    expect(extinctSourceCrossingComplete([{ id: "x:y.ts", count: 1, reason: "mid-crossing" }])).toBe(false);
  });
});

/** One line that must trip each declared source, so no entry can go dead. */
function probeTextFor(id: string): string {
  const probes: Record<string, string> = {
    "feedback-classification-hook": `hooks.on_feedback_classify = "classify";`,
    "deprecated-status-alias": `const tools = [{ name: "worker_status", invoke: readWorkers }];`,
    "fleet-registry": `const p = await readFleetProfiles(path);`,
    "fleet-registry-lane": `const p = join(root, "fleets.toonl");`,
    "fleet-name": `const name = parseFleetFlag(argv) ?? env["RED_AFK_FLEET"];`,
    "fleet-hooks": `await dispatchFleetHook(ctx, FLEET_HOOK_NAMES[0]);`,
    "fleet-mcp-tools": `const tools = createFleetTools(deps); const n = "fleet_register";`,
    "federated-fleet-view": `const view = aggregateFederatedFleetView(events);`,
    "attempt-record": `const r = await readCastleAttemptRecords(root);`,
    "attempt-retention": `const plan = planCastleReclaim(records);`,
    "attempt-lane": `const lane = paths.castleAttempts;`,
    "attempt-contract": `const contract = "red.castle.attempt.v1";`,
    "project-supervisor-entrypoint": `if (argv[0] === "__supervise") return superviseCommand(argv.slice(1));`,
    "project-supervisor-spawn": `const pid = await spawnSupervisor({ root, target });`,
    "project-supervisor-payload-key": `return { supervisor: publishSupervisorLiveness(anchor) };`,
    "dev-cli-binary": `const bin = "red-skills-dev";`,
    "dev-cli-router": `const parsed: CliCommand = parseCli(argv).command;`,
    "dev-worker-run-command": `const flags = parseRunFlags(argv);`,
    "dev-bundle-supervisor": `import { readSlotState } from "./supervisor/state.js";`,
    "project-launch-template": `const launch = buildProjectLaunchTemplate(input);`,
    "tmp-janitor": `const plan = planTmpJanitorSweep(root);`,
    "client-checkout-reclaim": `import { planWorkerReclaim } from "./worker-reclaim.js";`,
    "castle-resident-resource-kind": `const target = { kind: "castle-resident" };`,
  };
  const probe = probes[id];
  if (!probe) throw new Error(`no probe for extinct source ${id} — add one when adding an inventory entry`);
  return probe;
}

/** One declaration that must trip each declared NAME, so no entry can go dead. */
function nameProbeFor(id: string): string {
  const probes: Record<string, string> = {
    "attempt-keyed-accounting": `export function attemptUsage(slot: SlotState): AttemptBudgets { return {}; }`,
    "fleet-keyed-accounting": `export function sampleFleetPeakRss(state: SupervisorState): void {}`,
    "project-supervisor-naming": `export async function spawnSupervisor(opts: SupervisorEntryLookup): Promise<number> { return 0; }`,
    "project-supervisor-tick": `export async function superviseTick(): Promise<void> {}`,
    "project-supervisor-loop": `export async function runSupervisor(): Promise<void> {}`,
    "manual-landing-mode": `export async function handoffForManualLanding(c: StageCommon): Promise<void> {}`,
    "red-castle-naming": `import { Orchestrator } from "@reddb-io/red-castle";`,
    "castle-resident-naming": `export function startCastleResident(root: string): void {}`,
  };
  const probe = probes[id];
  if (!probe) throw new Error(`no probe for extinct name ${id} — add one when adding an inventory entry`);
  return probe;
}

/**
 * ADR 0130 Amendment 4 removed the per-project process and every name it wore —
 * the `__supervise` entrypoint, the `supervisor:` payload key, the launcher and
 * the watchdog that relaunched it (#2909). Deletion is half the job; these are
 * the other half, and they hold BOTH directions: a reader or a module carrying
 * the name fails, and prose describing what was removed does not.
 */
describe("the per-project process stays removed, and prose about it does not fail (#2909)", () => {
  const RELAUNCHER = `
import { spawn } from "node:child_process";

/** Bring the project's producer back up when its heartbeat goes stale. */
export async function spawnSupervisorWatchdog(root: string): Promise<number> {
  const child = spawn(process.execPath, [entry, "__supervise"], { detached: true });
  return child.pid ?? 0;
}
`;

  it("fails a module named for the removed process, naming the location and the route", () => {
    const path = "apps/dev/src/runtime/supervisor-watchdog-spawn.ts";
    const findings = collectExtinctSourceFindingsFromFiles([
      { relativePath: path, sourceText: RELAUNCHER },
    ]);
    const message = formatExtinctSourceFailureMessage(
      formatExtinctSourceViolations({ findings, baseline: [] }),
    );

    // The filename is the finding a text scan can never produce, so it is named
    // first — at line 1, where a reader opens the file.
    expect(findings.find((finding) => finding.kind === "module-name")).toMatchObject({
      match: "supervisor-watchdog-spawn",
      line: 1,
      column: 1,
    });
    expect(message).toContain(path);
    expect(message).toContain("__supervise");
    // The route, not only the refusal: the message says what to reach for instead.
    expect(message).toContain("redskilled-birth.ts");
    expect(message).toContain("createRedskilledBirthPort");
  });

  it("clears once the project contributes a registration instead of a process", () => {
    const registered = `
import { createRedskilledBirthPort } from "./redskilled-birth.js";

/** Ask the host to hold this project; the daemon polls and births the Worker. */
export async function registerProject(root: string, argv: readonly string[]) {
  const port = createRedskilledBirthPort({ root });
  await port.reach();
  return port.register({ selector: "{}", argv, workspace_path: root, target: 2 });
}
`;

    expect(
      collectExtinctSourceFindingsFromFiles([
        { relativePath: "apps/dev/src/runtime/project-registration.ts", sourceText: registered },
      ]),
    ).toEqual([]);
  });

  it("leaves prose describing the removal alone — a comment is documentation, not a reader", () => {
    // Every sentence here would trip the inventory if comments counted. They are
    // the migration's own explanation of what went, which is exactly the text a
    // later reader needs; a ratchet that reddened it would teach the next slice
    // to delete the reason rather than the code.
    const documented = `
// ADR 0130 Amendment 4 removed the per-project process: the \`__supervise\`
// entrypoint, \`spawnSupervisor\`, the \`supervisor-watchdog-spawn\` relauncher
// and the \`supervisor:\` key \`project_status\` answered with are all gone.
/* The launcher used to call spawnSupervisorWatchdog after buildWatchdogIO. */
export const PROJECT_LANE = "project";
`;

    expect(
      collectExtinctSourceFindingsFromFiles([
        { relativePath: "apps/dev/src/core/project-lane.ts", sourceText: documented },
      ]),
    ).toEqual([]);
  });

  it("keeps its own tolerance empty: this crossing shrinks the baseline, never grows it", () => {
    const supervisor = [...EXTINCT_SOURCES, ...EXTINCT_NAMES]
      .filter((entry) => entry.noun === "supervisor")
      .map((entry) => entry.id);

    expect(EXTINCT_SOURCE_BASELINE.filter((entry) => supervisor.includes(entry.id.split(":")[0]!))).toEqual([]);
  });
});

/**
 * THE SECOND CROSSING (ADRs 0147/0148/0149, Spec #4007, issue #4009). The first
 * one declared its inventory while deleting; this one declares it BEFORE, at
 * today's counts, because `red-skills-dev` still routes 36 commands, the dev
 * bundle is still a Worker body, the janitor still sweeps a human's checkout and
 * 97 modules still name `red-castle`. Four properties are load-bearing: the
 * declared counts ARE the tree's counts, one extra reference at ANY declared
 * location reds the guard, each entry names the route that replaced it, and the
 * surfaces that SURVIVE the redesign are not reddened by mistake.
 */
describe("the execution-chain crossing is declared at today's counts (#4009)", () => {
  const inventory = [...EXECUTION_CHAIN_SOURCES, ...EXECUTION_CHAIN_NAMES];
  const findings = collectExtinctSourceFindingsFromFiles(
    readExtinctSourceFiles(ROOT),
    EXECUTION_CHAIN_SOURCES,
    EXECUTION_CHAIN_NAMES,
  );

  it("names every surface the Spec asked it to name", () => {
    expect(inventory.map((entry) => entry.id)).toEqual([
      "dev-cli-binary",
      "dev-cli-router",
      "dev-worker-run-command",
      "dev-bundle-supervisor",
      "project-launch-template",
      "tmp-janitor",
      "client-checkout-reclaim",
      "castle-resident-resource-kind",
      "red-castle-naming",
      "castle-resident-naming",
    ]);
  });

  it("is green: the declared counts are the counts the tree actually carries", () => {
    const violations = formatExtinctSourceViolations({ findings, baseline: EXECUTION_CHAIN_BASELINE });

    expect(violations, formatExtinctSourceFailureMessage(violations)).toEqual([]);
  });

  it("declares no tolerance it cannot see — an over-declared count is slack nobody paid for", () => {
    // A baseline entry larger than the tree is a reference budget a later slice
    // can spend without anything failing, which is the ratchet leaking.
    const counted = new Map<string, number>();
    for (const finding of findings) counted.set(finding.locationKey, (counted.get(finding.locationKey) ?? 0) + 1);
    const drifted = EXECUTION_CHAIN_BASELINE.filter((entry) => counted.get(entry.id) !== entry.count).map(
      (entry) => `${entry.id} declares ${entry.count}, the tree carries ${counted.get(entry.id) ?? 0}`,
    );

    expect(drifted, drifted.join("\n")).toEqual([]);
    expect(EXECUTION_CHAIN_BASELINE.length).toBeGreaterThan(100);
  });

  it("fails when ANY declared location gains one reference (the ratchet itself)", () => {
    // Raising a baseline is exactly what a reintroduction needs, so one extra
    // reference at each declared location must red the guard on its own — all
    // 157 of them, not a sampled few.
    const survived = EXECUTION_CHAIN_BASELINE.filter((entry) => {
      const seed = findings.find((finding) => finding.locationKey === entry.id)!;
      const violations = formatExtinctSourceViolations({
        findings: [...findings, seed],
        baseline: EXECUTION_CHAIN_BASELINE,
      });
      return violations.length !== 1 || !violations[0]!.includes(seed.relativePath);
    }).map((entry) => entry.id);

    expect(survived, survived.join("\n")).toEqual([]);
  });

  it("names the route that replaced each surface, not only the refusal", () => {
    for (const entry of inventory) {
      expect(entry.replacement, `${entry.id} names no route a worker can act on`).toMatch(
        /\brs_(?:dev|memory|brain|github)\b|@reddb-io\/(?:worker|protocol-acp)|packages\/worker|\bredskilled\b|~\/\.red\/tmp\/workers/,
      );
      // The failure teaches the route, so the entry must also say what the
      // surface OWNED — a bare noun would red a word rather than a concept.
      expect(entry.what.length, `${entry.id} says too little about what it owned`).toBeGreaterThan(60);
    }
  });

  it("leaves the surfaces the redesign KEEPS alone", () => {
    // A ratchet that reds the replacement teaches the next slice to rename the
    // wrong thing: the `redskilled` binary and its own CLI, the daemon's launch
    // template and its reclaim over what it births, and rsp's resident
    // vocabulary whose code ADR 0147 keeps for the fold-in.
    const surviving = [
      `import { isPidAlive } from "@reddb-io/shared/resident-core.js";`,
      `import { ResidentRspClient, resolveResidentPaths } from "@reddb-io/shared/resident-client.js";`,
      `export const CLI_USAGE = "Usage: redskilled <command> [options]";`,
      `export type RedskilledLaunchTemplate = { argv: readonly string[] };`,
      `export function planDaemonReclaim(root: string): string[] { return []; }`,
      `export class RspResidentServer {}`,
    ].join("\n");

    expect(
      collectExtinctSourceFindingsFromFiles([{ relativePath: "apps/redskilled/src/daemon/x.ts", sourceText: surviving }]),
    ).toEqual([]);
  });

  it("exempts the second inventory module, and only by its exact path", () => {
    const declaration = readFileSync(join(ROOT, "apps/dev/src/core/extinct-execution-chain.ts"), "utf8");

    expect(EXTINCT_INVENTORY_PATHS).toEqual([
      "apps/dev/src/core/extinct-source-guard.ts",
      "apps/dev/src/core/extinct-execution-chain.ts",
    ]);
    expect(
      collectExtinctSourceFindingsFromFiles([
        { relativePath: "apps/dev/src/core/extinct-execution-chain.ts", sourceText: declaration },
      ]),
    ).toEqual([]);
    // Copied anywhere else the same text is a reader again, so the exemption
    // cannot be widened by moving the inventory into a friend module.
    expect(
      collectExtinctSourceFindingsFromFiles([
        { relativePath: "apps/dev/src/core/extinct-execution-chain.copy.ts", sourceText: declaration },
      ]),
    ).not.toEqual([]);
  });
});
