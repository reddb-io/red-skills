/**
 * The extinction ratchet: a reader that reintroduces a Fleet or Attempt source
 * fails here, and so does a module or symbol merely NAMED for one (issue #2795,
 * issue #2850, Spec #2772, ADR 0130).
 *
 * Deleting the code was the crossing; this keeps it deleted. The migration is
 * over — `EXTINCT_SOURCE_BASELINE` is empty — so the ratchet runs in the normal
 * check set and its tolerance is zero. Four properties are load-bearing: a new
 * reference FAILS and names its location, a NAME fails the same way a source
 * does, findings only ever DECREASE, and prose describing what was removed is
 * documentation rather than a reader.
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
  type ExtinctSourceBaselineEntry,
} from "../src/core/extinct-source-guard.js";
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

    expect(findings.every((finding) => finding.noun === "attempt")).toBe(true);
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

  it("earned the promotion: the crossing is complete, so the tolerance is empty", () => {
    expect(extinctSourceCrossingComplete()).toBe(true);
    expect(EXTINCT_SOURCE_BASELINE).toEqual([]);
    // And the rule is executable rather than remembered: a non-empty baseline
    // means the crossing is still running.
    expect(extinctSourceCrossingComplete([{ id: "x:y.ts", count: 1, reason: "mid-crossing" }])).toBe(false);
  });
});

/** One line that must trip each declared source, so no entry can go dead. */
function probeTextFor(id: string): string {
  const probes: Record<string, string> = {
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

  it("keeps the tolerance empty: this crossing shrinks the baseline, never grows it", () => {
    expect(EXTINCT_SOURCE_BASELINE).toEqual([]);
  });
});
