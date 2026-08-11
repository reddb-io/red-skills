// The repository poll spends budget for whoever is watching (ADR 0141, #3564).
//
// The counters used to come from a local `gh` cache under a fifteen-minute TTL,
// so an operator watching the line could not react to the repository. Moving the
// fetch into the daemon fixes the freshness and creates the opposite hazard: a
// host nobody is attached to would poll GitHub forever at the attended rate.
//
// Presence is the input, and it is the daemon's existing one — a session that is
// alive renews the registration it holds, which `registrationRenewalStatus`
// already calls `renewing`. Everything here drives that with a fake clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activityPollComesForward,
  interactiveSessionsHolding,
  isCacheWarmCadenceMs,
  nextActivityPollMs,
  REDSKILLED_AMORTIZED_MIN_MS,
  REDSKILLED_ACTIVITY_UNATTENDED_MS,
  REDSKILLED_CACHE_WARM_MAX_MS,
} from "../src/activity-cadence.js";
import { DEFAULT_REDSKILLED_ACTIVITY_MS } from "../src/repository-activity.js";
import { REDSKILLED_ACTIVITY_STALENESS_FACTOR } from "../src/activity-report.js";
import {
  buildProjectRegistration,
  renewProjectRegistration,
  sustainProjectRegistration,
  REDSKILLED_REGISTRATION_TTL_MS,
  type RedskilledProjectRegistration,
} from "../src/project-registration.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";

const T0 = "2026-08-11T09:00:00.000Z";
const T0_MS = Date.parse(T0);

/** A fake clock the daemon and the pure helpers can share. */
function fakeClock(startMs: number): { now: () => string; advance: (ms: number) => void } {
  let atMs = startMs;
  return {
    now: () => new Date(atMs).toISOString(),
    advance: (ms: number) => {
      atMs += ms;
    },
  };
}

function registration(atMs: number, label = "acme/p0"): RedskilledProjectRegistration {
  return buildProjectRegistration(
    { project_label: label, selector: "{}", argv: ["node", "dev.mjs", "run"], workspace_path: `/w/${label}`, target: 1 },
    { now: new Date(atMs).toISOString() },
  );
}

describe("the poll cadence follows presence", () => {
  it("tightens to the attended window while a session holds a registration", () => {
    expect(nextActivityPollMs({ attended: true })).toBe(DEFAULT_REDSKILLED_ACTIVITY_MS);
  });

  it("backs off when no session holds one", () => {
    expect(nextActivityPollMs({ attended: false })).toBe(REDSKILLED_ACTIVITY_UNATTENDED_MS);
  });

  it("honors a stated attended window, and still backs off from it", () => {
    expect(nextActivityPollMs({ attended: true, attendedMs: 15_000 })).toBe(15_000);
    expect(nextActivityPollMs({ attended: false, attendedMs: 15_000 })).toBe(REDSKILLED_ACTIVITY_UNATTENDED_MS);
  });

  it("never polls FASTER unattended than attended, whatever a caller states", () => {
    // The back-off may only ever slow down. A host nobody is watching that polled
    // harder than an attended one would spend more of exactly the budget its
    // idleness was meant to save.
    for (const attendedMs of [15_000, 30_000, 120_000, 600_000]) {
      const idle = nextActivityPollMs({ attended: false, attendedMs, unattendedMs: 1_000 });
      expect(idle, `attended ${attendedMs}ms`).toBeGreaterThanOrEqual(attendedMs);
    }
  });

  it("falls back to its own windows when a caller states nonsense", () => {
    expect(nextActivityPollMs({ attended: true, attendedMs: 0 })).toBe(DEFAULT_REDSKILLED_ACTIVITY_MS);
    expect(nextActivityPollMs({ attended: false, unattendedMs: Number.NaN }))
      .toBe(REDSKILLED_ACTIVITY_UNATTENDED_MS);
  });
});

describe("both declared cadences are legal under the cache-warm rule", () => {
  it("keeps the attended window inside the Spec's 15–30s band", () => {
    expect(DEFAULT_REDSKILLED_ACTIVITY_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_REDSKILLED_ACTIVITY_MS).toBeLessThanOrEqual(30_000);
  });

  it("keeps every cadence out of the ~300s prompt-cache dead zone", () => {
    // At or under 270s, or at or over 20 minutes. Never between them.
    for (const cadence of [DEFAULT_REDSKILLED_ACTIVITY_MS, REDSKILLED_ACTIVITY_UNATTENDED_MS]) {
      expect(isCacheWarmCadenceMs(cadence), `${cadence}ms`).toBe(true);
    }
    expect(isCacheWarmCadenceMs(300_000)).toBe(false);
    expect(isCacheWarmCadenceMs(REDSKILLED_CACHE_WARM_MAX_MS)).toBe(true);
    expect(isCacheWarmCadenceMs(REDSKILLED_CACHE_WARM_MAX_MS + 1)).toBe(false);
    expect(isCacheWarmCadenceMs(REDSKILLED_AMORTIZED_MIN_MS)).toBe(true);
  });

  it("keeps the back-off short enough that an attaching operator waits one window", () => {
    // The unattended window is also the worst case for how long somebody who
    // just attached is told an old number by a plainly-armed interval.
    expect(REDSKILLED_ACTIVITY_UNATTENDED_MS).toBeLessThanOrEqual(REDSKILLED_CACHE_WARM_MAX_MS);
  });
});

describe("presence is read off the registrations", () => {
  it("counts a registration a session was heard from inside the renewal cadence", () => {
    const held = registration(T0_MS);

    expect(interactiveSessionsHolding([held], T0_MS)).toBe(1);
    expect(interactiveSessionsHolding([held], T0_MS + REDSKILLED_REGISTRATION_TTL_MS / 2 - 1)).toBe(1);
  });

  it("stops counting one the session has gone quiet on", () => {
    const held = registration(T0_MS);

    expect(interactiveSessionsHolding([held], T0_MS + REDSKILLED_REGISTRATION_TTL_MS / 2 + 1)).toBe(0);
  });

  it("counts it again the moment the session renews", () => {
    const quietMs = T0_MS + REDSKILLED_REGISTRATION_TTL_MS / 2 + 1;
    const renewed = renewProjectRegistration(registration(T0_MS), { now: new Date(quietMs).toISOString() });

    expect(interactiveSessionsHolding([renewed], quietMs)).toBe(1);
  });

  it("does NOT count a drain the daemon is holding up on its own", () => {
    // A self-renewing registration is an autonomous drain nobody is watching —
    // the exact host this back-off exists for. Counting it as presence would
    // make an unattended AFK host poll at the attended rate forever.
    const quietMs = T0_MS + REDSKILLED_REGISTRATION_TTL_MS / 2 + 1;
    const sustained = sustainProjectRegistration(registration(T0_MS), {
      now: new Date(quietMs).toISOString(),
      queue: { outcome: "counted", depth: 4 },
    });

    expect(sustained.verdict).toBe("open-work");
    expect(interactiveSessionsHolding([sustained.registration], quietMs)).toBe(0);
  });

  it("counts nobody on a host with nothing registered, or with an unreadable clock", () => {
    expect(interactiveSessionsHolding([], T0_MS)).toBe(0);
    // Fail closed toward spending nothing: reading absence as presence costs
    // budget on counters no operator is reading.
    expect(interactiveSessionsHolding([registration(T0_MS)], Number.NaN)).toBe(0);
  });
});

describe("a waiting poll is brought forward when a session appears", () => {
  it("comes forward when an idle host's window is longer than presence now asks for", () => {
    expect(activityPollComesForward({
      pendingWindowMs: REDSKILLED_ACTIVITY_UNATTENDED_MS,
      cadenceMs: nextActivityPollMs({ attended: true }),
    })).toBe(true);
  });

  it("stays put when the window in force is the one already armed", () => {
    // A session renewing on a timer must never be able to push a waiting poll
    // away — that is a poll that never runs, dressed as freshness.
    const attended = nextActivityPollMs({ attended: true });
    expect(activityPollComesForward({ pendingWindowMs: attended, cadenceMs: attended })).toBe(false);
  });

  it("never pushes a tight poll out because a session went quiet", () => {
    expect(activityPollComesForward({
      pendingWindowMs: nextActivityPollMs({ attended: true }),
      cadenceMs: REDSKILLED_ACTIVITY_UNATTENDED_MS,
    })).toBe(false);
  });

  it("does nothing when no poll is armed, or when a window will not compare", () => {
    expect(activityPollComesForward({ pendingWindowMs: null, cadenceMs: 20_000 })).toBe(false);
    expect(activityPollComesForward({ pendingWindowMs: Number.NaN, cadenceMs: 20_000 })).toBe(false);
    expect(activityPollComesForward({ pendingWindowMs: 240_000, cadenceMs: Number.NaN })).toBe(false);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const REGISTRATION_REQUEST = {
  project_label: "acme/p0",
  selector: "{}",
  argv: ["node", "dev.mjs", "run"],
  workspace_path: "/w/p0",
  target: 1,
} as const;

describe("the daemon's own loop spends at the window presence asks for", () => {
  it("holds an idle host at the back-off, then tightens the moment a session registers", async () => {
    // Only the intervals are faked: the daemon's start still does real I/O, and
    // a fake clock over all of it would stall the bind rather than the timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let calls = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      repositoryActivity: {
        projects: [{ project_label: "acme/p0", owner: "acme", name: "p0" }],
        hostTokenRef: "host",
        intervalMs: 1_000,
        transport: async () => {
          calls += 1;
          return { data: { rateLimit: { remaining: 4_900, resetAt: null } } };
        },
      },
    });
    running.push(daemon);

    // One fetch at arming, so a daemon that just started is never empty. Then
    // silence: five attended windows pass and nobody is watching, so the poll is
    // still waiting out its four-minute one.
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);

    // A session registers. The waiting poll comes forward, and every window
    // after it is the attended one.
    daemon.registerProject({ ...REGISTRATION_REQUEST });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(6);
  });

  it("goes back to the back-off once the session stops speaking for its project", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let calls = 0;
    const clock = fakeClock(T0_MS);
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
      repositoryActivity: {
        projects: [{ project_label: "acme/p0", owner: "acme", name: "p0" }],
        hostTokenRef: "host",
        intervalMs: 1_000,
        transport: async () => {
          calls += 1;
          return { data: { rateLimit: { remaining: 4_900, resetAt: null } } };
        },
      },
    });
    running.push(daemon);
    daemon.registerProject({ ...REGISTRATION_REQUEST });

    await vi.advanceTimersByTimeAsync(3_000);
    const attended = calls;
    expect(attended).toBeGreaterThan(1);

    // The record still stands — it has not lapsed — but no session has spoken
    // for it inside the renewal cadence, so the host is unwatched again.
    clock.advance(REDSKILLED_REGISTRATION_TTL_MS / 2 + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const backedOff = calls;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toBe(backedOff);
  });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-cadence-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

describe("the daemon states the window its counters were promised at", () => {
  it("moves the payload's staleness threshold as presence comes and goes", async () => {
    // The cadence is not on the wire, but the promise it makes is: the payload's
    // threshold is two windows of the cadence in force, so an idle host's
    // four-minute-old counters are not reported as a poller that stopped.
    const clock = fakeClock(T0_MS);
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    const thresholdMs = (): number => daemon.statuslinePayload().repository_activity.threshold_ms;
    const attended = REDSKILLED_ACTIVITY_STALENESS_FACTOR * DEFAULT_REDSKILLED_ACTIVITY_MS;
    const unattended = REDSKILLED_ACTIVITY_STALENESS_FACTOR * REDSKILLED_ACTIVITY_UNATTENDED_MS;

    expect(thresholdMs()).toBe(unattended);

    daemon.registerProject({
      project_label: "acme/p0",
      selector: "{}",
      argv: ["node", "dev.mjs", "run"],
      workspace_path: "/w/p0",
      target: 1,
    });
    expect(thresholdMs()).toBe(attended);

    // The session stops speaking for it. The record still stands — it has not
    // lapsed — but nobody is watching, so the poll backs off.
    clock.advance(REDSKILLED_REGISTRATION_TTL_MS / 2 + 1_000);
    expect(thresholdMs()).toBe(unattended);
  });
});
