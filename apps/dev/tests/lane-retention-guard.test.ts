/**
 * The lane-retention invariant: every surviving redskilled and Worker TOONL
 * lane declares exactly one retention policy in the registry, the census can
 * observe it, and a writer enforces it at append time (issue #3645).
 *
 * The sweep excludes the census module itself — the census READS every policy,
 * so counting it as enforcement would make an unenforced lane look bounded,
 * which is precisely how `castle-history` stayed boot-only for so long.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import {
  auditLaneRetention,
  LANE_WRITER_ENFORCEMENT,
  registeredLaneNames,
  type LaneEnforcementSite,
} from "../src/core/lane-retention-guard.js";
import { laneCensusLaneIds } from "../src/core/operational-probes/lane-census.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["apps", "packages"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "dist-bundle", "generated", ".turbo"]);
/** The registry declares; the census reads. Neither is a writer. */
const NON_WRITERS = new Set([
  "packages/shared/lane-retention.ts",
  "apps/dev/src/core/operational-probes/lane-census.ts",
  "apps/dev/src/core/lane-retention-guard.ts",
]);
const REFERENCE = /LANE_RETENTION_REGISTRY\["([a-z-]+)"\]/g;

/** Every `LANE_RETENTION_REGISTRY["<lane>"]` reference in non-test source. */
function sweepEnforcementSites(): LaneEnforcementSite[] {
  const sites: LaneEnforcementSite[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
      const module = relative(ROOT, path).split(sep).join("/");
      if (NON_WRITERS.has(module)) continue;
      for (const match of readFileSync(path, "utf8").matchAll(REFERENCE)) {
        sites.push({ lane: match[1]!, module });
      }
    }
  };
  for (const root of SCANNED_ROOTS) walk(join(ROOT, root));
  return sites;
}

describe("lane retention is a writer-enforced contract (#3645)", () => {
  it("maps every registered lane to a census entry and a live writer", () => {
    const findings = auditLaneRetention({
      registered: registeredLaneNames(),
      censused: laneCensusLaneIds(),
      enforced: sweepEnforcementSites(),
    });
    expect(
      findings,
      findings.length === 0
        ? ""
        : `lane-retention invariant: ${findings.length} finding(s).\n`
          + findings.map((f) => `  - [${f.kind}] ${f.reason}`).join("\n"),
    ).toEqual([]);
  });

  it("declares each lane once, with a reason and at least one writer", () => {
    const lanes = LANE_WRITER_ENFORCEMENT.map((entry) => entry.lane);
    expect(new Set(lanes).size).toBe(lanes.length);
    for (const entry of LANE_WRITER_ENFORCEMENT) {
      expect(entry.writers.length).toBeGreaterThan(0);
      expect(entry.why.trim().length).toBeGreaterThan(20);
    }
  });

  it("fails for a REGISTERED lane no writer enforces", () => {
    const findings = auditLaneRetention({
      registered: ["ghost-lane"],
      censused: ["ghost-lane"],
      enforced: [],
      declared: [{ lane: "worker-log", writers: [], why: "posed" }],
    });
    const unenforced = findings.find((f) => f.kind === "registered-unenforced");
    expect(unenforced?.lane).toBe("ghost-lane");
    expect(unenforced?.reason).toContain("no writer consumes");
  });

  it("fails for an ENFORCED lane missing from the registry", () => {
    const findings = auditLaneRetention({
      registered: [],
      censused: [],
      enforced: [{ lane: "private-ceiling", module: "apps/redskilled/src/event-lane.ts" }],
      declared: [],
    });
    const unregistered = findings.find((f) => f.kind === "enforced-unregistered");
    expect(unregistered?.lane).toBe("private-ceiling");
    expect(unregistered?.reason).toContain("apps/redskilled/src/event-lane.ts");
    expect(unregistered?.reason).toContain("no census can audit");
  });

  it("fails for a declared writer that stopped enforcing its lane", () => {
    const findings = auditLaneRetention({
      registered: ["worker-log"],
      censused: ["worker-log"],
      enforced: [{ lane: "worker-log", module: "apps/dev/src/runtime/worker-log-retention.ts" }],
      declared: [{ lane: "worker-log", writers: ["apps/dev/src/gone.ts"], why: "posed reason long enough" }],
    });
    expect(findings.map((f) => f.kind)).toContain("stale-writer");
    expect(findings.map((f) => f.kind)).toContain("undeclared-writer");
  });

  it("keeps the retired RSP and Castle lanes out of the registry", () => {
    // #3896 retired the resident producer and the private workflow lanes; the
    // census must never resurrect one just to make this invariant total.
    for (const retired of [
      "castle-resident-events",
      "castle-producer",
      "rsp-workflow-spool",
      "castle-supervisor-log",
      "castle-monitor-log",
    ]) {
      expect(Object.keys(LANE_RETENTION_REGISTRY)).not.toContain(retired);
      expect(laneCensusLaneIds()).not.toContain(retired);
    }
  });

  it("runs in every gate cone as a repo-wide invariant", () => {
    const names = REPO_INVARIANT_SUITES.map((suite) => suite.name);
    expect(names).toContain("invariants:lane-retention");
  });
});
