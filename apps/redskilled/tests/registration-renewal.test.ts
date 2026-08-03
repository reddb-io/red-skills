// A registration outlives the session that created it, and lapses once nothing
// renews it. Both halves are load-bearing and pull against each other: the drain
// has to survive the operator closing the terminal, and a closed laptop must not
// poll a repository forever. What is proven here is that a registration nobody
// renews keeps being polled right up to its deadline and stops at it, that a
// renewed one never reaches a deadline at all, and that `host-state` says which
// of the two an operator is looking at.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  registerRedskilledProject,
  renewRedskilledProject,
  readRedskilledHostState,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildProjectRegistration,
  hasRegistrationLapsed,
  REDSKILLED_RENEWAL_CADENCE,
  registrationRenewalStatus,
  renewProjectRegistration,
  RedskilledProjectUnregisteredError,
  sweepLapsedRegistrations,
  type RedskilledProjectRegistrationRequest,
} from "../src/project-registration.js";
import { evaluateSessionReach, REDSKILLED_OP_REACH } from "../src/session-reach.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

const T0 = "2026-07-31T12:00:00.000Z";
const WINDOW_MS = 60_000;

function request(
  overrides: Partial<RedskilledProjectRegistrationRequest> = {},
): RedskilledProjectRegistrationRequest {
  return {
    project_label: "acme/widgets",
    selector: "is:open label:ready-for-agent",
    argv: ["red-skills-dev", "__work"],
    workspace_path: "/tmp/acme-widgets",
    target: 3,
    renew_within_ms: WINDOW_MS,
    ...overrides,
  };
}

/** A clock a test moves by hand, so a deadline is reached without waiting for one. */
function testClock(start = T0) {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms).toISOString(),
    advance(by: number) {
      ms += by;
    },
  };
}

describe("a registration outlives its session", () => {
  it("keeps polling a registration nobody is renewing, all the way to its deadline", async () => {
    const clock = testClock();
    const queried: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          queried.push(query);
          return { data: { q0: { issueCount: 4 } } };
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(request());
    // The session ends here. Nothing renews the registration from this point on,
    // and the drain must carry on regardless — that is the whole promise the
    // detached per-project process used to keep.
    clock.advance(WINDOW_MS - 1);

    const polled = await daemon.pollQueueDiscovery();
    expect(polled?.projects.map((entry) => entry.project_label)).toEqual(["acme/widgets"]);
    expect(queried).toHaveLength(1);
    expect(daemon.hostState().registrations).toHaveLength(1);
  });

  it("lapses at the stated interval and stops being polled", async () => {
    const clock = testClock();
    const queried: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          queried.push(query);
          return { data: { q0: { issueCount: 4 } } };
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(request());
    clock.advance(WINDOW_MS);

    // A lapsed registration is not a project with an empty queue: it is a project
    // the host no longer asks the tracker about at all.
    expect(await daemon.pollQueueDiscovery()).toBeNull();
    expect(queried).toEqual([]);
    expect(daemon.hostState().registrations).toEqual([]);
  });

  it("never lapses while a session renews it, however many windows pass", async () => {
    const clock = testClock();
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    for (let tick = 0; tick < 10; tick += 1) {
      // Renewed at the half-life, which is the cadence the deadline states.
      clock.advance(WINDOW_MS * REDSKILLED_RENEWAL_CADENCE);
      const renewed = await renewRedskilledProject(paths, { project_label: "acme/widgets" }, {
        sessionProject: "acme/widgets",
      });
      expect(renewed.registration.renewals).toBe(tick + 1);
      expect(daemon.hostState().registrations).toHaveLength(1);
    }

    // Ten windows on, and everything the project stated about its work is the
    // record it registered with: a renewal moves the deadline and nothing else.
    const held = daemon.hostState().registrations![0]!;
    expect(held.registered_at).toBe(T0);
    expect(held.selector).toBe("is:open label:ready-for-agent");
    expect(held.argv).toEqual(["red-skills-dev", "__work"]);
    expect(held.target).toBe(3);
  });

  it("holds the daemon awake while a registration stands, and lets go when it lapses", async () => {
    const clock = testClock();
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    daemon.registerProject(request());
    // No Worker is running: a project between Workers is exactly the state the
    // host has to stay awake for, and a daemon that idled out under it would end
    // the drain the operator walked away from.
    expect(daemon.workerCount()).toBe(0);
    expect(daemon.evaluateIdle()).toBe("held-by-registrations");

    clock.advance(WINDOW_MS);
    expect(daemon.evaluateIdle()).toBe("exited");
  });
});

describe("host state says whether a registration is still being renewed", () => {
  it("reports a renewing session, then the drain that outlived it", async () => {
    const clock = testClock();
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    expect((await readRedskilledHostState(paths)).registrations![0]!.renewal).toBe("renewing");

    // Still inside the cadence: a session that renews at the half-life has not
    // gone quiet yet, and calling it abandoned here would be calling every
    // healthy session abandoned between two ticks.
    clock.advance(WINDOW_MS * REDSKILLED_RENEWAL_CADENCE);
    expect(daemon.hostState().registrations![0]!.renewal).toBe("renewing");

    // Past it, with nothing heard: the registration is still held and still
    // polled, and an operator can now see that nobody is watching it.
    clock.advance(1);
    const outlived = daemon.hostState().registrations![0]!;
    expect(outlived.renewal).toBe("running-on");
    expect(outlived.project_label).toBe("acme/widgets");

    // A renewal puts it back — the verdict is about silence, not about age.
    await renewRedskilledProject(paths, { project_label: "acme/widgets" }, { sessionProject: "acme/widgets" });
    expect(daemon.hostState().registrations![0]!.renewal).toBe("renewing");
  });

  it("states no renewal verdict when the read states no instant to judge against", () => {
    const registration = buildProjectRegistration(request(), { now: T0 });
    // A judgement invented from the daemon's start time would report a
    // registration nobody has renewed in an hour as being renewed.
    expect(registrationRenewalStatus(registration, Date.parse(T0))).toBe("renewing");
    expect(registrationRenewalStatus(registration, Date.parse(T0) + WINDOW_MS)).toBe("running-on");
  });
});

describe("renewing a registration the daemon does not hold", () => {
  it("refuses rather than minting one, because the strings were never kept", async () => {
    const clock = testClock();
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    await expect(
      renewRedskilledProject(paths, { project_label: "acme/widgets" }, { sessionProject: "acme/widgets" }),
    ).rejects.toThrow(/acme\/widgets/);

    daemon.registerProject(request());
    clock.advance(WINDOW_MS);
    // A lapsed record renews into the same refusal as one that never existed: the
    // client's next move is to register again, stating its selector and argv.
    expect(() => daemon.renewProject("acme/widgets")).toThrow(RedskilledProjectUnregisteredError);
    expect(daemon.hostState().registrations).toEqual([]);
  });

  it("renews into the session's own project and refuses another one", async () => {
    expect(REDSKILLED_OP_REACH["project-renew"]).toBe("project-write");
    const refused = evaluateSessionReach({
      op: "project-renew",
      sessionProject: "acme/widgets",
      targetProject: "acme/gadgets",
    });
    expect(refused.permitted).toBe(false);
    expect(refused.verdict).toBe("refused-cross-project");

    const clock = testClock();
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    daemon.registerProject(request({ project_label: "acme/gadgets" }));
    await expect(
      renewRedskilledProject(paths, { project_label: "acme/gadgets" }, { sessionProject: "acme/widgets" }),
    ).rejects.toThrow(/acme\/gadgets/);
    // Refused, and the deadline it aimed at is exactly where it was.
    expect(daemon.hostState().registrations![0]!.renewals).toBe(0);
  });

  it("registers again after a lapse, because the record it would collide with is gone", async () => {
    const clock = testClock();
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      clock: clock.now,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    clock.advance(WINDOW_MS);
    const again = await registerRedskilledProject(paths, request({ target: 9 }), {
      sessionProject: "acme/widgets",
    });
    expect(again.registration.target).toBe(9);
    expect(again.registration.renewals).toBe(0);
  });
});

describe("the renewal arithmetic itself", () => {
  it("dates the deadline from the renewal, never from the registration", () => {
    const held = buildProjectRegistration(request(), { now: T0 });
    expect(held.renewed_at).toBe(T0);
    expect(held.renewals).toBe(0);

    const at = new Date(Date.parse(T0) + 30_000).toISOString();
    const renewed = renewProjectRegistration(held, { now: at });
    expect(renewed.renewed_at).toBe(at);
    expect(renewed.renew_by).toBe(new Date(Date.parse(at) + WINDOW_MS).toISOString());
    // Everything about the work is carried over untouched.
    expect({ ...renewed, renewed_at: "", renew_by: "", renewals: 0, session_renewals: 0 }).toEqual({
      ...held,
      renewed_at: "",
      renew_by: "",
      renewals: 0,
    });
  });

  it("restates the window when a session asks for a different one", () => {
    const held = buildProjectRegistration(request(), { now: T0 });
    const renewed = renewProjectRegistration(held, { now: T0, renew_within_ms: 5_000 });
    expect(renewed.renew_within_ms).toBe(5_000);
    expect(renewed.renew_by).toBe(new Date(Date.parse(T0) + 5_000).toISOString());
    expect(() => renewProjectRegistration(held, { now: T0, renew_within_ms: 0 })).toThrow(/renewal window/);
    expect(() => renewProjectRegistration(held, { now: "not an instant" })).toThrow(/instant/);
  });

  it("lapses at the deadline and not a millisecond before it", () => {
    const held = buildProjectRegistration(request(), { now: T0 });
    const deadline = Date.parse(held.renew_by);
    expect(hasRegistrationLapsed(held, deadline - 1)).toBe(false);
    expect(hasRegistrationLapsed(held, deadline)).toBe(true);
    // An undatable deadline stops nothing: dropping a record over a timestamp
    // nobody can read would stop work for a reason no operator ever stated.
    expect(hasRegistrationLapsed({ ...held, renew_by: "whenever" }, deadline)).toBe(false);
  });

  it("splits a set into what still stands and what lapsed, naming both", () => {
    const standing = buildProjectRegistration(request({ project_label: "a/one" }), { now: T0 });
    const lapsing = buildProjectRegistration(
      request({ project_label: "b/two", renew_within_ms: 1_000 }),
      { now: T0 },
    );
    const swept = sweepLapsedRegistrations([standing, lapsing], Date.parse(T0) + 30_000);
    expect(swept.standing.map((held) => held.project_label)).toEqual(["a/one"]);
    // The lapse is returned rather than silently dropped: a caller that only got
    // the survivors could not say which project stopped, or when.
    expect(swept.lapsed.map((held) => held.project_label)).toEqual(["b/two"]);
  });
});
