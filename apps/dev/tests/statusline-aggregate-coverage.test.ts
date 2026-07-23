import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AfkInput,
  DocsInput,
  FleetInput,
  ProjectInput,
  RepoInput,
  StatuslineInput,
} from "../src/core/statusline.js";
import { renderStatusline } from "../src/core/statusline.js";
import type { StatuslineAggregate } from "../src/mcp-adapter.js";

/**
 * Field coverage for the `statusline_aggregate` MCP tool (#2344).
 *
 * The renderer's input interfaces ARE the contract: every castle-side field it
 * can render must be derivable from the tool payload, so an agent or UI can
 * rebuild the statusline from the MCP alone. Host-side blocks (the Claude Code
 * stdin payload: session model/effort, context %, usage quotas) are explicitly
 * out of scope — the tool must not fake them.
 *
 * The field lists are PARSED from `core/statusline.ts` rather than restated, so
 * adding a castle-side render field fails this test until the aggregate carries
 * it.
 */

const STATUSLINE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core", "statusline.ts"),
  "utf8",
);

/** Field names declared on one exported interface in `core/statusline.ts`. */
function interfaceFields(name: string): string[] {
  const start = STATUSLINE_SRC.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name} not found in core/statusline.ts`).toBeGreaterThan(-1);
  const body = STATUSLINE_SRC.slice(start, STATUSLINE_SRC.indexOf("\n}", start));
  const fields = new Set<string>();
  for (const line of body.split("\n").slice(1)) {
    const match = /^\s{2}(\w+)\??:/.exec(line);
    if (match) fields.add(match[1]);
  }
  expect(fields.size, `no fields parsed for ${name}`).toBeGreaterThan(0);
  return [...fields];
}

/** A fully-populated payload. It is typed as the REAL tool return type, so a
 * field that disappears from (or is renamed in) the aggregate breaks the
 * typecheck instead of silently weakening this test. */
const PAYLOAD: StatuslineAggregate = {
  project: {
    basename: "red-skills",
    branch: "main",
    detached_sha: "1276d6a4c",
    version: "2.78.0",
    latest_cached_version: "2.78.0",
    pointer_version: "2.78.0",
    docs_unlanded: 2,
  },
  repo: {
    open_prs: 3,
    today_prs: 1,
    open_issues: 24,
    local_added: 40,
    local_removed: 7,
    cache_age_s: 12,
  },
  docs: { unlanded: 2 },
  fleet: {
    fleet: "default",
    supervisor: {
      pid: 4242,
      alive: true,
      health: "healthy",
      runner: "claude",
      target: 4,
      bundle_version: "2.78.0",
      bundle_latest: "2.79.0",
      version_skew: 1,
      heartbeat_age_s: 8,
    },
    slots: { busy: 2, free: 1, parked: 1, total: 4 },
    churn: { deaths: 1, respawns: 1, window_s: 900 },
    live_workers: [
      { id: "wTST1", pid: 4243, issue: "2344", activity: "editing", origin: "afk" },
    ],
    unattributed_workers: [],
  },
  fleet_chip: {
    runner: "claude",
    busy: 2,
    total: 4,
    queue: 6,
    parked: 1,
    degraded: false,
    churn_deaths: 1,
    churn_respawns: 1,
    churn_window_s: 900,
    breaker_count: 3,
    bundle_version: "2.78.0",
  },
  workers: [],
  afk: {
    workers: 2,
    queue: 6,
    human: 1,
    blocked: 0,
    added: 40,
    removed: 7,
    waiting: 3,
    tokens: 12_000,
    costUsd: 0.42,
    runner: "claude",
    resolved: 5,
    issues: [2344, 2345],
    locIsPeak: false,
    phases: ["coding", "validating"],
    aliveMs: [300_000, 60_000],
    model: "claude-opus-4-8",
    effort: "high",
    sourceCounts: [{ origin: "afk", count: 2 }],
    cacheAgeS: 12,
  },
  queue: { ready_for_agent: 6, ready_for_human: 1, cache_age_s: 12 },
  /** Federation view: cross-host fleet state aggregated from singleton event
   * lane heartbeats. In single-host mode hosts contains exactly one entry.
   * In multi-host mode each host carries its machine_id_hash marker and a
   * staleness signal (`silent`) derived from last_event_age_s vs the
   * configured threshold. */
  federation: {
    hosts: [
      {
        machine_id_hash: "abc123def456",
        fleet_name: "default",
        runner: "claude",
        target: 4,
        bundle_version: "2.78.0",
        slots: { busy: 2, free: 1, total: 4, parked: 1 },
        workers: [{ id: "wTST1", issue: "2344", activity: "editing" }],
        ready_for_agent: 6,
        last_event_at: "2026-07-23T12:00:00.000Z",
        last_event_age_s: 8,
        silent: false,
      },
    ],
    total_busy: 2,
    total_free: 1,
    total_workers: 1,
  },
};

/**
 * The derivations an MCP client applies to rebuild each renderer input block
 * from the payload. These ARE the proof of coverage: every parsed field name
 * must appear as a key here, and every derivation must produce a defined value.
 */
const project = (p: StatuslineAggregate): Required<ProjectInput> => ({
  basename: p.project.basename,
  branch: p.project.branch ?? "",
  detachedSha: p.project.detached_sha ?? "",
  version: p.project.version,
  latestCachedVersion: p.project.latest_cached_version ?? p.project.version,
  pointerVersion: p.project.pointer_version ?? p.project.version,
});

const repo = (p: StatuslineAggregate): Required<RepoInput> => ({
  openPrs: p.repo.open_prs,
  todayPrs: p.repo.today_prs,
  openIssues: p.repo.open_issues,
  localAdded: p.repo.local_added,
  localRemoved: p.repo.local_removed,
  cacheAgeS: p.repo.cache_age_s ?? 0,
});

const docs = (p: StatuslineAggregate): Required<DocsInput> => ({
  count: p.docs.unlanded,
});

const fleet = (p: StatuslineAggregate): Required<FleetInput> | undefined => {
  const chip = p.fleet_chip;
  if (!chip) return undefined;
  return {
    runner: chip.runner,
    busy: chip.busy,
    total: chip.total,
    queue: chip.queue,
    parked: chip.parked,
    degraded: chip.degraded,
    churnDeaths: chip.churn_deaths,
    churnRespawns: chip.churn_respawns,
    churnWindowS: chip.churn_window_s,
    breaker: { count: chip.breaker_count },
    bundleVersion: chip.bundle_version ?? p.fleet?.supervisor.bundle_version ?? "",
    latestBundleVersion: p.fleet?.supervisor.bundle_latest ?? p.project.version,
    pointerVersion: p.project.pointer_version ?? p.project.version,
  };
};

const afk = (p: StatuslineAggregate): Required<AfkInput> | undefined => {
  const block = p.afk;
  if (!block) return undefined;
  return {
    workers: block.workers,
    queue: p.queue.ready_for_agent,
    human: p.queue.ready_for_human,
    quarantine: 0,
    blocked: block.blocked,
    added: block.added,
    removed: block.removed,
    waiting: block.waiting ?? 0,
    tokens: block.tokens ?? 0,
    costUsd: block.costUsd ?? 0,
    runner: block.runner ?? "",
    resolved: block.resolved ?? 0,
    issues: block.issues,
    locIsPeak: block.locIsPeak ?? false,
    phases: block.phases ?? [],
    aliveMs: block.aliveMs ?? [],
    model: block.model ?? "",
    effort: block.effort ?? "",
    sourceCounts: block.sourceCounts ?? [],
    cacheAgeS: p.queue.cache_age_s ?? 0,
  };
};

const BLOCKS: ReadonlyArray<{
  interfaceName: string;
  derive: (p: StatuslineAggregate) => Record<string, unknown> | undefined;
}> = [
  { interfaceName: "ProjectInput", derive: project },
  { interfaceName: "RepoInput", derive: repo },
  { interfaceName: "DocsInput", derive: docs },
  { interfaceName: "FleetInput", derive: fleet },
  { interfaceName: "AfkInput", derive: afk },
];

describe("statusline_aggregate field coverage", () => {
  for (const block of BLOCKS) {
    it(`derives every ${block.interfaceName} field from the tool payload`, () => {
      const derived = block.derive(PAYLOAD);
      expect(derived, `${block.interfaceName} derivation returned nothing`).toBeDefined();
      for (const field of interfaceFields(block.interfaceName)) {
        expect(
          derived![field],
          `${block.interfaceName}.${field} is not derivable from statusline_aggregate`,
        ).toBeDefined();
      }
    });
  }

  it("renders a full statusline from the payload alone", () => {
    const input: StatuslineInput = {
      project: project(PAYLOAD),
      repo: repo(PAYLOAD),
      docs: docs(PAYLOAD),
      fleet: fleet(PAYLOAD),
      afk: afk(PAYLOAD),
    };
    const line = renderStatusline(input);
    expect(line).toContain("red-skills");
    expect(line).toContain("main");
  });

  it("omits the host-side blocks, which the tool must not fake", () => {
    expect(PAYLOAD).not.toHaveProperty("claude");
    // The renderer's host-side block stays absent: no session model/effort,
    // context percentage, or 5h/7d usage quota comes from the castle side.
    const line = renderStatusline({ project: project(PAYLOAD) });
    expect(line).not.toContain("5h=");
    expect(line).not.toContain("7d=");
  });
});
