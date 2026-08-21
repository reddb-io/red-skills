// lane-retention-guard — retention is a WRITER-enforced contract, and the
// registry is the one place it is declared (issue #3645).
//
// Two drifts made a declared ceiling meaningless in practice. `castle-history`
// carried `maxLines: 10_000` that only BOOT applied, so a long-lived generation
// grew the ledger without bound between restarts — registered, unenforced. The
// daemon's own event lane ran the opposite way: its writer trimmed correctly
// off a private `DEFAULT_REDSKILLED_EVENT_LANE_MAX_BYTES`, which meant the
// number lived where no census could audit it — enforced, unregistered.
//
// Neither shape is visible to a type checker: one is a policy nobody reads, the
// other a constant nobody registers. So the mapping is DECLARED here — lane →
// the writer modules that consume its policy — and the guard pins that
// declaration against the live registry, the live census, and the live tree in
// both directions.

import { LANE_RETENTION_REGISTRY, type LaneRetentionPolicyName } from "@reddb-io/shared/lane-retention.js";

/** One registered lane paired with every module that enforces its policy. */
export interface LaneWriterEnforcement {
  /** The registry key — the lane's one declared policy. */
  readonly lane: LaneRetentionPolicyName;
  /** Repo-relative modules that consume `LANE_RETENTION_REGISTRY[lane]`. */
  readonly writers: readonly string[];
  /** One line on WHAT bounds the lane — read by whoever hits the refusal. */
  readonly why: string;
}

/**
 * The declared registry-to-writer mapping. Every registry key needs an entry,
 * and every entry's module must actually reference its lane: a lane whose
 * writer forgot the policy is bounded by nothing, and a writer whose lane left
 * the registry is a ceiling only it can see.
 */
export const LANE_WRITER_ENFORCEMENT: readonly LaneWriterEnforcement[] = [
  {
    lane: "process-deaths",
    writers: ["packages/shared/death-record.ts"],
    why: "the death lane is byte- and age-bounded as each dying process appends its own record",
  },
  {
    lane: "death-attributions",
    writers: ["packages/shared/death-attribution.ts"],
    why: "attribution rows are written from a synchronous exit handler, so the same ceilings apply without an await",
  },
  {
    lane: "github-spend",
    writers: ["packages/github/attribution.ts"],
    why: "every attributed GitHub call appends one spend row, so the ceiling rides the attribution writer",
  },
  {
    lane: "github-balance",
    writers: ["packages/github/balance-store.ts"],
    why: "the balance is one current snapshot; the small hard ceiling makes schema growth visible instead of silent",
  },
  {
    lane: "github-balance-history",
    writers: ["packages/github/balance-history.ts"],
    why: "balance samples accumulate one row per probe, bounded by bytes at append time",
  },
  {
    lane: "castle-singleton-events",
    writers: ["packages/worker/src/engine/singleton-event-lane.ts"],
    why: "singleton arbitration rows are byte-bounded so one contested boot cannot fill the state tier",
  },
  {
    lane: "castle-history",
    writers: [
      "packages/worker/src/engine/lane-writers.ts",
      "apps/plugin-dev/src/core/history.ts",
    ],
    why: "the durable ledger is LINE-bounded on every append; boot's trim is a sweep, never the enforcement point",
  },
  {
    lane: "redskilled-events",
    writers: ["apps/redskilled/src/event-lane.ts"],
    why: "the daemon's one structured log compacts to the registry's target ratio when an append would cross its ceiling",
  },
  {
    lane: "rsp-telemetry-spool",
    writers: ["apps/rsp/src/telemetry/spool.ts"],
    why: "the telemetry spool is byte-bounded so an undrained resident cannot grow the state tier without limit",
  },
  {
    lane: "rsp-telemetry-corrections",
    writers: ["apps/rsp/src/telemetry/spool.ts"],
    why: "correction rows share the spool writer and carry their own, much smaller ceiling",
  },
  {
    lane: "worker-log",
    writers: ["apps/plugin-dev/src/runtime/worker-log-retention.ts"],
    why: "a Worker's TOONL narration is line-bounded at the quiescent point, after its file logger has closed",
  },
  {
    lane: "verdicts",
    writers: ["apps/plugin-dev/src/core/verdict-ledger.ts"],
    why: "the append-only merge authorization is byte-bounded as each verifier appends its row, so an audit trail cannot outgrow the durable state tier",
  },
  {
    lane: "worker-liveness",
    writers: [
      "packages/worker/src/LivenessLane.ts",
      "packages/worker/src/engine/lane-writers.ts",
    ],
    why: "the liveness anchor is byte-bounded on every heartbeat so a long-lived Worker cannot outgrow its own proof of life",
  },
];

/** One `LANE_RETENTION_REGISTRY["<lane>"]` reference found in the live tree. */
export interface LaneEnforcementSite {
  readonly lane: string;
  /** Repo-relative module path, forward-slashed. */
  readonly module: string;
}

export type LaneRetentionFindingKind =
  | "registered-unenforced"
  | "enforced-unregistered"
  | "registered-uncensused"
  | "censused-unregistered"
  | "undeclared-writer"
  | "stale-writer";

export interface LaneRetentionFinding {
  readonly kind: LaneRetentionFindingKind;
  readonly lane: string;
  readonly reason: string;
}

export interface LaneRetentionAuditInput {
  /** Keys of the live `LANE_RETENTION_REGISTRY`. */
  readonly registered: readonly string[];
  /** Lane ids the live census can emit. */
  readonly censused: readonly string[];
  /** Registry references swept from the live tree, census module excluded. */
  readonly enforced: readonly LaneEnforcementSite[];
  /** Defaults to the declared mapping above. */
  readonly declared?: readonly LaneWriterEnforcement[];
}

function sitesByLane(sites: readonly LaneEnforcementSite[]): Map<string, Set<string>> {
  const byLane = new Map<string, Set<string>>();
  for (const site of sites) {
    const modules = byLane.get(site.lane) ?? new Set<string>();
    modules.add(site.module);
    byLane.set(site.lane, modules);
  }
  return byLane;
}

/**
 * Every way the registry, the census, the declared writers, and the live tree
 * can disagree about who bounds a lane. An empty result is the contract held.
 * PURE.
 *
 * Findings NAME the missing half, because the reader of one is someone who
 * added a lane or a writer and has to be told which of the two they skipped.
 */
export function auditLaneRetention(input: LaneRetentionAuditInput): LaneRetentionFinding[] {
  const declared = input.declared ?? LANE_WRITER_ENFORCEMENT;
  const registered = new Set(input.registered);
  const censused = new Set(input.censused);
  const enforced = sitesByLane(input.enforced);
  const declaredByLane = new Map(declared.map((entry) => [entry.lane as string, entry]));
  const findings: LaneRetentionFinding[] = [];

  for (const lane of [...registered].sort()) {
    const modules = enforced.get(lane);
    if (modules === undefined || modules.size === 0) {
      findings.push({
        kind: "registered-unenforced",
        lane,
        reason: `lane "${lane}" declares a retention policy no writer consumes. A ceiling only a boot sweep applies is unbounded between boots — make the lane's append path read LANE_RETENTION_REGISTRY["${lane}"], or drop the registration.`,
      });
    }
    if (!censused.has(lane)) {
      findings.push({
        kind: "registered-uncensused",
        lane,
        reason: `lane "${lane}" is registered but the census never enumerates it, so an operator cannot observe whether the policy holds. Add it to lane-census.ts.`,
      });
    }
    if (!declaredByLane.has(lane)) {
      findings.push({
        kind: "undeclared-writer",
        lane,
        reason: `lane "${lane}" has no LANE_WRITER_ENFORCEMENT entry naming the module that bounds it.`,
      });
    }
  }

  for (const lane of [...enforced.keys()].sort()) {
    if (registered.has(lane)) continue;
    findings.push({
      kind: "enforced-unregistered",
      lane,
      reason: `lane "${lane}" is enforced by ${[...enforced.get(lane)!].sort().join(", ")} but carries no registry entry, so its ceiling lives where no census can audit it. Declare it in LANE_RETENTION_REGISTRY.`,
    });
  }

  for (const lane of [...censused].sort()) {
    if (registered.has(lane)) continue;
    findings.push({
      kind: "censused-unregistered",
      lane,
      reason: `the census enumerates lane "${lane}" with a policy the registry does not declare.`,
    });
  }

  for (const entry of declared) {
    const modules = enforced.get(entry.lane) ?? new Set<string>();
    for (const writer of entry.writers) {
      if (modules.has(writer)) continue;
      findings.push({
        kind: "stale-writer",
        lane: entry.lane,
        reason: `${writer} is declared as a writer for lane "${entry.lane}" but no longer references LANE_RETENTION_REGISTRY["${entry.lane}"]. An inventory nobody prunes is one nobody trusts.`,
      });
    }
    for (const module of modules) {
      if (entry.writers.includes(module)) continue;
      findings.push({
        kind: "undeclared-writer",
        lane: entry.lane,
        reason: `${module} enforces lane "${entry.lane}" without appearing in its LANE_WRITER_ENFORCEMENT writers.`,
      });
    }
  }

  return findings;
}

/** The live registry keys, in declaration order. PURE. */
export function registeredLaneNames(): string[] {
  return Object.keys(LANE_RETENTION_REGISTRY);
}
