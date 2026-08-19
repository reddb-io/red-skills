import { describe, expect, it } from "vitest";
import {
  ORPHAN_TTL_LONG_S,
  ORPHAN_TTL_SHORT_S,
  decideOrphanFate,
  planAttemptCap,
  planLivenessReclaim,
  type AttemptDir,
  type LivenessReclaimInput,
  type OrphanFate,
  type OrphanInput,
} from "../src/core/reclaim.js";

const DAY = 86400;
const NOW = 1700000000;

/** Build a minimal orphan input, overriding only the fields under test. */
function orphan(over: Partial<OrphanInput>): OrphanInput {
  return {
    issueState: "OPEN",
    label: null,
    envelopePosted: false,
    hasStateFile: true,
    ageS: 0,
    ghOk: true,
    ...over,
  };
}

describe("decideOrphanFate", () => {
  it("CLOSED issue is removed immediately", () => {
    expect(decideOrphanFate(orphan({ issueState: "CLOSED" }))).toEqual<OrphanFate>({
      kind: "remove",
    });
  });

  it("ready-for-human with envelope.posted=true uses the 1-day split TTL", () => {
    expect(
      decideOrphanFate(orphan({ issueState: "OPEN", label: "ready-for-human", envelopePosted: true })),
    ).toEqual<OrphanFate>({ kind: "keep-until", ttlS: ORPHAN_TTL_SHORT_S });
    expect(ORPHAN_TTL_SHORT_S).toBe(1 * DAY);
  });

  it("ready-for-human with envelope.posted=false uses the 7-day split TTL", () => {
    expect(
      decideOrphanFate(orphan({ issueState: "OPEN", label: "ready-for-human", envelopePosted: false })),
    ).toEqual<OrphanFate>({ kind: "keep-until", ttlS: ORPHAN_TTL_LONG_S });
    expect(ORPHAN_TTL_LONG_S).toBe(7 * DAY);
  });

  it("running issue (crashed mid-issue) restores the queue then removes the dir", () => {
    expect(
      decideOrphanFate(orphan({ issueState: "OPEN", label: "running" })),
    ).toEqual<OrphanFate>({ kind: "restore-and-remove" });
  });

  it("any other open state is removed", () => {
    expect(decideOrphanFate(orphan({ issueState: "OPEN", label: "needs-triage" }))).toEqual<OrphanFate>({
      kind: "remove",
    });
    expect(decideOrphanFate(orphan({ issueState: "OPEN", label: null }))).toEqual<OrphanFate>({
      kind: "remove",
    });
  });

  it("CLOSED wins even when a stale ready-for-human label is still attached", () => {
    expect(
      decideOrphanFate(orphan({ issueState: "CLOSED", label: "ready-for-human", envelopePosted: true })),
    ).toEqual<OrphanFate>({ kind: "remove" });
  });

  describe("gh-failure mtime TTL fallback", () => {
    it("with a state file → 7-day TTL", () => {
      expect(decideOrphanFate(orphan({ ghOk: false, hasStateFile: true }))).toEqual<OrphanFate>({
        kind: "keep-until",
        ttlS: ORPHAN_TTL_LONG_S,
      });
    });

    it("without a state file → 1-day TTL", () => {
      expect(decideOrphanFate(orphan({ ghOk: false, hasStateFile: false }))).toEqual<OrphanFate>({
        kind: "keep-until",
        ttlS: ORPHAN_TTL_SHORT_S,
      });
    });
  });

  it("no state file (no issue number) → 1-day TTL regardless of gh", () => {
    // A dir with no state file carries no issue number, so gh is never queried;
    // it is garbage past the short TTL. Mirrors the bash `-z issue_n` branch.
    expect(decideOrphanFate(orphan({ hasStateFile: false, ghOk: true }))).toEqual<OrphanFate>({
      kind: "keep-until",
      ttlS: ORPHAN_TTL_SHORT_S,
    });
  });
});

/** Build an attempt dir fixture under the nested layout for issue 42. */
function attempt(num: number, ageS: number, live = false): AttemptDir {
  return { path: `/root/workers/wAAA/42-a${num}`, mtimeS: NOW - ageS, live };
}

describe("planAttemptCap", () => {
  it("reaps attempts older than the age cap, keeps the rest", () => {
    const attempts: AttemptDir[] = [
      attempt(1, 20 * DAY),
      attempt(2, 16 * DAY),
      attempt(3, 1 * DAY),
    ];
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 5, nowS: NOW });
    expect(reaped.map((a) => a.path)).toEqual([
      "/root/workers/wAAA/42-a1",
      "/root/workers/wAAA/42-a2",
    ]);
  });

  it("reaps the oldest-by-attempt-number over the count cap, keeping the newest KEEP", () => {
    const attempts: AttemptDir[] = [
      attempt(1, 1 * DAY),
      attempt(2, 1 * DAY),
      attempt(3, 1 * DAY),
      attempt(4, 1 * DAY),
    ];
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 2, nowS: NOW });
    // Keep a3, a4 (newest two by attempt number); drop a1, a2.
    expect(reaped.map((a) => a.path)).toEqual([
      "/root/workers/wAAA/42-a1",
      "/root/workers/wAAA/42-a2",
    ]);
  });

  it("count cap ranks by attempt number, not mtime", () => {
    // a4 is the oldest on disk but the newest attempt number → it survives.
    const attempts: AttemptDir[] = [
      attempt(1, 1 * DAY),
      attempt(2, 2 * DAY),
      attempt(3, 3 * DAY),
      attempt(4, 10 * DAY),
    ];
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 2, nowS: NOW });
    expect(reaped.map((a) => a.path)).toEqual([
      "/root/workers/wAAA/42-a1",
      "/root/workers/wAAA/42-a2",
    ]);
  });

  it("applies age and count caps together — age first, count over the survivors", () => {
    const attempts: AttemptDir[] = [
      attempt(1, 20 * DAY), // over age cap → reaped by age
      attempt(2, 1 * DAY),
      attempt(3, 1 * DAY),
      attempt(4, 1 * DAY),
    ];
    // After age cull, survivors are a2,a3,a4; keep=2 → drop a2.
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 2, nowS: NOW });
    expect(reaped.map((a) => a.path)).toEqual([
      "/root/workers/wAAA/42-a1",
      "/root/workers/wAAA/42-a2",
    ]);
  });

  it("never counts or removes a live attempt", () => {
    const attempts: AttemptDir[] = [
      attempt(1, 20 * DAY, true), // live AND over age cap → still spared
      attempt(2, 1 * DAY),
      attempt(3, 1 * DAY),
      attempt(4, 1 * DAY, true), // live → excluded from the count too
    ];
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 2, nowS: NOW });
    // Live a1/a4 excluded entirely. Non-live survivors a2,a3 fit under keep=2.
    expect(reaped).toEqual([]);
  });

  it("a live attempt does not consume a keep slot", () => {
    const attempts: AttemptDir[] = [
      attempt(1, 1 * DAY),
      attempt(2, 1 * DAY),
      attempt(3, 1 * DAY, true), // live, not counted
    ];
    // Non-live a1,a2 under keep=2 → nothing reaped, even though there are 3 dirs.
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 2, nowS: NOW });
    expect(reaped).toEqual([]);
  });

  it("ignores attempt dirs whose path does not parse under the nested layout", () => {
    const attempts: AttemptDir[] = [
      { path: "/root/garbage/not-an-attempt", mtimeS: NOW - 20 * DAY, live: false },
      attempt(1, 20 * DAY),
    ];
    const reaped = planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 5, nowS: NOW });
    expect(reaped.map((a) => a.path)).toEqual(["/root/workers/wAAA/42-a1"]);
  });

  it("returns nothing when every attempt is within both caps", () => {
    const attempts: AttemptDir[] = [attempt(1, 1 * DAY), attempt(2, 2 * DAY)];
    expect(planAttemptCap(attempts, { ttlS: 14 * DAY, keep: 5, nowS: NOW })).toEqual([]);
  });
});

// issue #1219 PART 4: liveness-gated read-time reclaim planner.
describe("planLivenessReclaim (issue #1219)", () => {
  const NOW = 2_000_000_000;
  const input = (over: Partial<LivenessReclaimInput>): LivenessReclaimInput => ({
    attemptDir: "/r/.red/tmp/workers/wA/5-a1",
    worktreePath: "/r/.red/tmp/workers/wA/5-a1/worktree",
    liveness: "dead",
    issueState: "CLOSED",
    mtimeS: NOW,
    ...over,
  });

  it("never touches a dir the daemon has not called dead", () => {
    expect(planLivenessReclaim([input({ liveness: "unknown" })], NOW)).toEqual([]);
  });

  it("never touches a live worker's dir", () => {
    expect(planLivenessReclaim([input({ liveness: "alive" })], NOW)).toEqual([]);
  });

  it("strips a dead Worker's worktree at the 14-day OPEN-issue threshold", () => {
    const [action] = planLivenessReclaim(
      [input({ issueState: "OPEN", mtimeS: NOW - 14 * DAY })],
      NOW,
    );
    expect(action.removeWorktree).toBe(true);
    expect(action.reclaimDir).toBe(false);
    expect(action.writeTombstone).toBe(true);
  });

  it("reclaims a dead Worker's CLOSED issue immediately", () => {
    const [action] = planLivenessReclaim([input({ issueState: "CLOSED" })], NOW);
    expect(action.removeWorktree).toBe(true);
    expect(action.reclaimDir).toBe(true);
    expect(action.writeTombstone).toBe(false);
  });

  it("keeps a live worker's dir while reclaiming a sibling dead worker", () => {
    const actions = planLivenessReclaim([
      input({ attemptDir: "/r/.red/tmp/workers/wLIVE/5-a1", liveness: "alive" }),
      input({ attemptDir: "/r/.red/tmp/go-workers/wDEAD/6-a1", liveness: "dead" }),
    ], NOW);
    expect(actions.map((a) => a.attemptDir)).toEqual(["/r/.red/tmp/go-workers/wDEAD/6-a1"]);
  });
});
