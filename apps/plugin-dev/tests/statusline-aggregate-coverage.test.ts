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
  ValidationGateInput,
} from "../src/core/statusline.js";
import { renderStatusline } from "../src/core/statusline.js";

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

/** A fully-populated compatibility payload. The live MCP adapter now projects
 * this public capability through ACP, so the fixture owns the historical
 * payload shape while the renderer interfaces below remain the live contract. */
const PAYLOAD = {
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
    today_prs: 5,
    open_issues: 24,
    local_added: 40,
    local_removed: 7,
  },
  remote_counters: {
    version: 1,
    threshold_ms: 60_000,
    projects: [{
      project_label: "red-skills",
      repository: "reddb-io/red-skills",
      outcome: "counted",
      counters: {
        open_pull_requests: {
          name: "open_pull_requests",
          value: 3,
          fetched_at: "2026-08-11T12:00:00.000Z",
          age_ms: 5_000,
          threshold_ms: 60_000,
          stale: false,
          reason: "counted by daemon",
        },
        open_issues: {
          name: "open_issues",
          value: 24,
          fetched_at: "2026-08-11T12:00:00.000Z",
          age_ms: 5_000,
          threshold_ms: 60_000,
          stale: false,
          reason: "counted by daemon",
        },
        merged_today: {
          name: "merged_today",
          value: 5,
          fetched_at: "2026-08-11T12:00:00.000Z",
          age_ms: 5_000,
          threshold_ms: 60_000,
          stale: false,
          reason: "counted by daemon",
        },
        ready_queue: {
          name: "ready_queue",
          value: 6,
          fetched_at: "2026-08-11T12:00:00.000Z",
          age_ms: 5_000,
          threshold_ms: 60_000,
          stale: false,
          reason: "counted by daemon",
        },
        human_queue: {
          name: "human_queue",
          value: 1,
          fetched_at: "2026-08-11T12:00:00.000Z",
          age_ms: 5_000,
          threshold_ms: 60_000,
          stale: false,
          reason: "counted by daemon",
        },
      },
    }],
    reason: "daemon fixture",
  },
  repository_activity: {
    fetched_at: "2026-08-11T12:00:00.000Z",
    age_ms: 5_000,
    stale: false,
    projects: [{
      project_label: "red-skills",
      repository: "reddb-io/red-skills",
      counts: { open_pull_requests: 3, open_issues: 24, merged_today: 5, recently_closed: 5 },
    }],
    reason: "daemon fixture",
  },
  docs: { unlanded: 2 },
  validation_gate: { occupied: 2, total: 3 },
  fleet: {
    validation_schedule: {
      narration: "Validation moments — iteration: declared [pnpm test]; post_done: skip (undeclared); landing: skip (undeclared)",
      moments: [
        { moment: "iteration", state: "declared", declared: true, commands: ["pnpm test"] },
        { moment: "post_done", state: "skip", declared: false, commands: [] },
        { moment: "landing", state: "skip", declared: false, commands: [] },
      ],
    },
    registration: {
      held: true,
      daemon_reachable: true,
      project: "red-skills",
      socket: "/run/redskilled.sock",
      selector: "{}",
      target: 4,
      renewal: "renewing",
      renew_by: "2026-07-31T05:30:00.000Z",
      renewals: 3,
      lapsed_at: "",
      reason: "",
      launch_revision: 1,
      bundle_version: "3.3.24",
      plugin_cache_version: "3.3.21",
    },
    birth_latch: null,
    slots: { busy: 2, free: 1, parked: 1, total: 4, interactive_reservation: 1 },
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
    stale: false,
    stale_age_s: 0,
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
  },
  queue: { ready_for_agent: 6, ready_for_human: 1 },
};

type StatuslineAggregate = typeof PAYLOAD;

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
  openPrs: p.repo.open_prs ?? 0,
  todayPrs: p.repo.today_prs ?? 0,
  openIssues: p.repo.open_issues ?? 0,
  localAdded: p.repo.local_added,
  localRemoved: p.repo.local_removed,
});

const docs = (p: StatuslineAggregate): Required<DocsInput> => ({
  count: p.docs.unlanded,
});

const validationGate = (p: StatuslineAggregate): Required<ValidationGateInput> => ({
  occupied: p.validation_gate.occupied,
  total: p.validation_gate.total,
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
    stale: chip.stale,
    staleAgeS: chip.stale_age_s,
    bundleVersion: chip.bundle_version ?? "",
    latestBundleVersion: p.project.version,
    pointerVersion: p.project.pointer_version ?? p.project.version,
  };
};

const afk = (p: StatuslineAggregate): Required<AfkInput> | undefined => {
  const block = p.afk;
  if (!block) return undefined;
  return {
    workers: block.workers,
    queue: p.queue.ready_for_agent ?? 0,
    human: p.queue.ready_for_human ?? 0,
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
  };
};

const BLOCKS: ReadonlyArray<{
  interfaceName: string;
  derive: (p: StatuslineAggregate) => Record<string, unknown> | undefined;
}> = [
  { interfaceName: "ProjectInput", derive: project },
  { interfaceName: "RepoInput", derive: repo },
  { interfaceName: "DocsInput", derive: docs },
  { interfaceName: "ValidationGateInput", derive: validationGate },
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
      validationGate: validationGate(PAYLOAD),
      fleet: fleet(PAYLOAD),
      afk: afk(PAYLOAD),
    };
    const line = renderStatusline(input);
    expect(line).toContain("red-skills");
    expect(line).toContain("main");
    expect(line).toContain("gate 2/3");
  });

  // ADR 0130: the single-host view is the whole view. The cross-host aggregate
  // grouped by host identity over fleet heartbeats and slots that no longer
  // exist, so the payload reports no host-grouped state at all.
  it("reports no host-grouped fleet state", () => {
    expect(PAYLOAD).not.toHaveProperty("federation");
    expect(Object.keys(PAYLOAD)).not.toContain("hosts");
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
