/**
 * The extinction ratchet: a reader that reintroduces a Fleet or Attempt source
 * fails here (issue #2795, Spec #2772, ADR 0130).
 *
 * Deleting the code was the crossing; this keeps it deleted. The migration is
 * over — `EXTINCT_SOURCE_BASELINE` is empty — so the ratchet runs in the normal
 * check set and its tolerance is zero. Three properties are load-bearing: a new
 * reference FAILS and names its location, findings only ever DECREASE, and prose
 * describing what was removed is documentation rather than a reader.
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
    // of #2697, and the work selector outlived the fleet that owned it.
    const source = [
      `import type { CastleAttemptStatus } from "./contracts/index.js";`,
      `export const FLEET_SCOPE_ENV = "RED_AFK_FLEET_SCOPE";`,
      `export const MEMORY_HIGH_ENV = "RED_AFK_FLEET_SCOPE_MEMORY_HIGH";`,
      `export function readWorkSelector(value: unknown): WorkSelector { return parseWorkSelector(value); }`,
      `export const lane = paths.projectSupervisor;`,
      `export function attemptBudget(worker: string): number { return 3; }`,
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
  };
  const probe = probes[id];
  if (!probe) throw new Error(`no probe for extinct source ${id} — add one when adding an inventory entry`);
  return probe;
}
