// poison-chain.test.ts — end-to-end regression fixture for the 2026-07-22
// incident class (#2529, Spec #2523).
//
// On 2026-07-22 the fleet froze three separate times because three defects
// compounded: a dead worker's un-conceded ghost claim red-halted every boot,
// incoherent issues (contradictory state labels + an active blocker) deepened
// the freeze with every crash, and one worker-killing issue burned respawns
// forever. This fixture seeds ALL THREE simultaneously next to a healthy
// sibling and asserts the full ADR 0122 healed outcome in one run:
//
//   1. the same-machine dead-pid ghost claim is auto-conceded (#2473/#2321),
//   2. the incoherent issue is quarantined with its diagnosis (#2521 posture),
//   3. the issue with 2 prior heals is quarantined on its 3rd heal (#2526),
//   4. the healthy sibling is claimed and processed in the same run.
//   5. a running-labeled dead-pid ghost is conceded before worker spawn (#2566).
//
// The per-mechanism tests below are mutation checks: removing any one healing
// mechanism (auto-concede, quarantine, heal ledger) makes the incident class
// reappear, and each test pins exactly how.

import { runCastleWorkerDrain, type HealLedgerState, type HealLedgerStore } from "@reddb-io/worker/engine";
import { describe, expect, it, vi } from "vitest";
import { BootHaltError } from "../src/core/boot.js";
import { NOW, makeDeps, options, runBoot } from "./boot.helpers.js";

const GHOST_CLAIM = "<!-- afk:claim v1 worker=local:wGhost kind=claim runner=codex -->";
const KILLER_CLAIM = "<!-- afk:claim v1 worker=local:wKiller kind=claim runner=codex -->";
const RUNNING_GHOST_CLAIM = "<!-- afk:claim v1 worker=local:wRunningGhost kind=claim runner=codex -->";

const BLOCKER_BODY = [
  "## Current blocker",
  "",
  "<!-- red:blocker-state v1 -->",
  "status: blocked",
  "kind: validation",
  "ref: #2496",
  "summary: Gate failed before the manual requeue.",
  "next: Confirm the issue is safe to delegate again.",
  "<!-- /red:blocker-state -->",
].join("\n");

interface MutableIssue {
  number: number;
  title: string;
  labels: string[];
  body: string;
}

/** The four 2026-07-22 archetypes, one issue each. */
function incidentIssues(): {
  ghost: MutableIssue;
  incoherent: MutableIssue;
  killer: MutableIssue;
  healthy: MutableIssue;
  runningGhost: MutableIssue;
  all: MutableIssue[];
} {
  const ghost: MutableIssue = {
    number: 3001,
    title: "Held by a dead worker's un-conceded claim",
    labels: ["ready-for-agent"],
    body: "## Agent brief\n\nShip the ghost-held slice.",
  };
  const incoherent: MutableIssue = {
    number: 3002,
    title: "Contradictory state labels + active blocker",
    labels: ["ready-for-agent", "ready-for-human", "priority:normal"],
    body: BLOCKER_BODY,
  };
  const killer: MutableIssue = {
    number: 3003,
    title: "Kills every worker that touches it",
    labels: ["ready-for-agent"],
    body: "## Agent brief\n\nThe worker-killing slice.",
  };
  const healthy: MutableIssue = {
    number: 3004,
    title: "Healthy sibling",
    labels: ["ready-for-agent", "priority:normal"],
    body: "## Agent brief\n\nShip the healthy slice.",
  };
  const runningGhost: MutableIssue = {
    number: 3005,
    title: "Running issue held by a dead worker's un-conceded claim",
    labels: ["running"],
    body: "## Agent brief\n\nResume the stranded running slice.",
  };
  return {
    ghost,
    incoherent,
    killer,
    healthy,
    runningGhost,
    all: [ghost, incoherent, killer, healthy, runningGhost],
  };
}

function seededLedger(killerIssue: number, priorHeals: number): HealLedgerStore & { value: HealLedgerState } {
  // The boot clock is the harness's fixed NOW (seconds) — the ledger window
  // filter compares against deps.nowS * 1000, so prior heals must sit just
  // before that instant, not wall-clock Date.now().
  const now = NOW * 1000;
  return {
    value: {
      version: 1,
      issues: priorHeals > 0 ? { [String(killerIssue)]: Array.from({ length: priorHeals }, (_, i) => now - (i + 1) * 60_000) } : {},
    },
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
  };
}

function incidentOptions(
  issues: MutableIssue[],
  ghost: MutableIssue,
  killer: MutableIssue,
  runningGhost: MutableIssue,
) {
  return options({
    operationalProbes: {
      remoteUrls: [],
      claimHygiene: {
        ownWorkerPrefix: "local:",
        listOpenQueueIssues: async () => [
          { number: ghost.number, comments: [{ id: 1, body: GHOST_CLAIM, createdAt: "2026-07-22T10:00:00Z" }] },
          { number: killer.number, comments: [{ id: 2, body: KILLER_CLAIM, createdAt: "2026-07-22T10:00:00Z" }] },
          {
            number: runningGhost.number,
            comments: [{ id: 3, body: RUNNING_GHOST_CLAIM, createdAt: "2026-07-23T11:00:00Z" }],
          },
        ],
        workerPidState: () => "dead",
      },
      labelBodyCoherence: {
        listOpenReadyIssues: async () => issues.filter((issue) => issue.labels.includes("ready-for-agent")),
      },
    },
  });
}

/** Wire the gh mutation surface against the mutable issue array so the test
 * asserts FINAL ISSUE STATE, not exact edit call shapes — the assertions
 * survive transition-API internals changing underneath (#2524/#2528). */
function wireDeps(
  deps: ReturnType<typeof makeDeps>["deps"],
  issues: MutableIssue[],
  over: { failLabelsFor?: number; ledger?: HealLedgerStore | undefined } = {},
) {
  const concedeClaim = vi.fn(async (_issue: number, _body: string) => undefined);
  const editLabels = vi.fn(async (number: number, remove: string[], add: string[]) => {
    if (over.failLabelsFor === number) throw new Error("label mutation failed");
    const issue = issues.find((candidate) => candidate.number === number)!;
    issue.labels = issue.labels.filter((label) => !remove.includes(label));
    issue.labels.push(...add.filter((label) => !issue.labels.includes(label)));
  });
  const editBody = vi.fn(async (number: number, body: string) => {
    issues.find((candidate) => candidate.number === number)!.body = body;
  });
  deps.concedeClaim = concedeClaim;
  deps.gh.editLabels = editLabels;
  Object.assign(deps.gh, {
    editBody,
    viewBody: async (number: number) => issues.find((candidate) => candidate.number === number)?.body ?? "",
    viewLabels: async (number: number) => issues.find((candidate) => candidate.number === number)?.labels ?? [],
  });
  if ("ledger" in over) {
    Object.assign(deps, { healLedger: over.ledger });
  }
  return { concedeClaim, editLabels, editBody };
}

async function drainAfterBoot(
  deps: ReturnType<typeof makeDeps>["deps"],
  issues: MutableIssue[],
  bootOptions: ReturnType<typeof options>,
) {
  const processed: number[] = [];
  const result = await runCastleWorkerDrain(
    {
      gh: {
        listCandidates: async () => issues.filter((issue) => issue.labels.includes("ready-for-agent")),
      },
      runBoot,
      bootDeps: deps,
      bootOptions,
      processIssue: async (_processDeps: object, input: { issue: number; runner: "codex" }) => {
        processed.push(input.issue);
        return { outcome: "done" as const };
      },
      processDeps: {},
      buildProcessInput: (issue) => ({ issue: issue.number, runner: "codex" as const }),
      emit: () => undefined,
    },
    {
      runner: "codex",
      workerId: "wPOIS",
      filter: { kind: "all" },
      issueTemplate: {},
    },
  );
  return { processed, result };
}

describe("2026-07-22 poison-chain regression fixture (#2529)", () => {
  it("heals the whole incident class in one run while the fleet keeps draining", async () => {
    const { ghost, incoherent, killer, healthy, runningGhost, all } = incidentIssues();
    const { deps } = makeDeps();
    const ledger = seededLedger(killer.number, 2);
    const { concedeClaim, editBody } = wireDeps(deps, all, { ledger });

    const { processed, result } = await drainAfterBoot(
      deps,
      all,
      incidentOptions(all, ghost, killer, runningGhost),
    );

    // Boot survived the full poison chain — no red halt, the fleet drains.
    expect(result.boot.bootstrap).toEqual({ ok: true });

    // (1, 5) Both queue and running-labeled ghosts are conceded before worker
    // spawn. The killer's dead claim routes to quarantine instead, see (3).
    expect(concedeClaim).toHaveBeenCalledTimes(2);
    expect(concedeClaim.mock.calls.map(([issue]) => issue)).toEqual([
      ghost.number,
      runningGhost.number,
    ]);

    // (2) Incoherent issue quarantined with its diagnosis appended.
    expect(incoherent.labels).toContain("quarantine");
    expect(incoherent.labels).not.toContain("ready-for-agent");
    expect(incoherent.labels).not.toContain("ready-for-human");
    expect(incoherent.body).toContain("Quarantine");

    // (3) Killer issue quarantined on its 3rd heal in 24h — not conceded again.
    expect(killer.labels).toContain("quarantine");
    expect(killer.labels).not.toContain("ready-for-agent");
    expect(editBody.mock.calls.some(([n, body]) => n === killer.number && String(body).includes("3 heals within 24h"))).toBe(true);

    // (4) The healthy sibling (and the freed ghost issue) processed in the SAME run.
    expect(processed).toContain(healthy.number);
    expect(processed).toContain(ghost.number);
    expect(processed).not.toContain(incoherent.number);
    expect(processed).not.toContain(killer.number);
  });

  it("mutation check — without auto-concede, the ghost claim red-halts the boot again", async () => {
    const { ghost, killer, runningGhost, all } = incidentIssues();
    const { deps } = makeDeps();
    wireDeps(deps, all, { ledger: seededLedger(killer.number, 2) });
    deps.concedeClaim = undefined;

    await expect(
      runBoot(deps, incidentOptions(all, ghost, killer, runningGhost)),
    ).rejects.toBeInstanceOf(BootHaltError);
  });

  it("mutation check — without the quarantine write, the poison stays on the tracker (local exclusion only)", async () => {
    // The coherence heal is deliberately best-effort per issue: a failed label
    // write excludes the issue from THIS drain but leaves the tracker poisoned
    // for the curator belt to retry. Without the quarantine mechanism, the
    // contradictory shape survives on the tracker — the incident class is back.
    const { ghost, incoherent, killer, runningGhost, all } = incidentIssues();
    const { deps } = makeDeps();
    wireDeps(deps, all, { ledger: seededLedger(killer.number, 2), failLabelsFor: incoherent.number });

    const { processed } = await drainAfterBoot(
      deps,
      all,
      incidentOptions(all, ghost, killer, runningGhost),
    );

    expect(incoherent.labels).toContain("ready-for-agent");
    expect(incoherent.labels).toContain("ready-for-human");
    expect(incoherent.labels).not.toContain("quarantine");
    expect(processed).not.toContain(incoherent.number);
  });

  it("mutation check — without the heal ledger, the killer issue is conceded forever instead of quarantined", async () => {
    const { ghost, killer, runningGhost, all } = incidentIssues();
    const { deps } = makeDeps();
    const { concedeClaim } = wireDeps(deps, all, { ledger: undefined });

    const result = await runBoot(deps, incidentOptions(all, ghost, killer, runningGhost));

    // All three dead claims conceded — the killer keeps burning workers.
    expect(concedeClaim).toHaveBeenCalledTimes(3);
    expect(killer.labels).not.toContain("quarantine");
    expect(result.quarantinedIssues ?? []).not.toContain(killer.number);
  });
});
