// The other half of the lease (ADR 0130 Amendment 7, #2973). Amendment 4 made a
// registration the thing that keeps a drain alive and gave it a deadline; the
// deadline shipped and the renewal had no owner, so every drain stopped one window
// after it started. What is proven here: a project with open work outlives its
// window without one message from a session, a Worker is still born after the
// original deadline has passed, a project with nothing left lapses and SAYS it
// lapsed, and no surface renders a lapsed registration as a healthy project.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { buildHostState } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildProjectRegistration,
  registrationRenewalStatus,
  renewProjectRegistration,
  sustainProjectRegistration,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "../src/project-registration.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";
import {
  renderRedskilledStatusline,
  REDSKILLED_STATUSLINE_DEFAULTS,
  type RedskilledStatuslineOptions,
} from "@reddb-io/redskilled-render";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

const T0 = "2026-07-31T12:00:00.000Z";
const WINDOW_MS = 60_000;

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-sustain-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
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

function request(
  overrides: Partial<RedskilledProjectRegistrationRequest> = {},
): RedskilledProjectRegistrationRequest {
  return {
    project_label: "acme/widgets",
    selector: "is:open label:ready-for-agent",
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: "/tmp/acme-widgets",
    target: 1,
    renew_within_ms: WINDOW_MS,
    ...overrides,
  };
}

function held(overrides: Partial<RedskilledProjectRegistration> = {}): RedskilledProjectRegistration {
  return { ...buildProjectRegistration(request(), { now: T0 }), ...overrides };
}

/** One GraphQL answer per registered project, in the order the daemon asked. */
function answer(depths: readonly number[]): unknown {
  const data: Record<string, unknown> = { rateLimit: { remaining: 4_900, resetAt: null } };
  depths.forEach((depth, index) => {
    data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}

/** A launch that births nothing: the lease is what is under test, not the spawn. */
function recordingLaunch(launched: LaunchWorkerOptions[]) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    launched.push(options);
    born += 1;
    return {
      worker: {
        worker_id: `w${born}`,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        pid: 1_000 + born,
        started_at: T0,
        isolated: false,
        warnings: [],
      },
      admission: options.admission,
      warnings: [],
      plan: {
        backend: "none",
        command: options.spec.command,
        args: [...(options.spec.args ?? [])],
        isolated: false,
        warnings: [],
      } as unknown as LaunchedWorker["plan"],
      child: { pid: 1_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

describe("sustainProjectRegistration — what holds a lease up", () => {
  it("pushes the deadline out on a counted, positive depth", () => {
    const at = new Date(Date.parse(T0) + 30_000).toISOString();
    const sustained = sustainProjectRegistration(held(), { now: at, queue: { outcome: "counted", depth: 4 } });

    expect(sustained.verdict).toBe("open-work");
    expect(sustained.registration.renew_by).toBe(new Date(Date.parse(at) + WINDOW_MS).toISOString());
    expect(sustained.registration.sustains).toBe(1);
    expect(sustained.registration.sustained_by).toBe("open-work");
    expect(sustained.registration.sustained_at).toBe(at);
    // `renewals` is the end-to-end counter: the deadline moved, so the counter
    // moves. `session_renewals` keeps the narrower diagnostic fact below.
    expect(sustained.registration.renewals).toBe(1);
    expect(sustained.registration.session_renewals).toBe(0);
    // The SESSION's clock is untouched: a sustained registration is still one
    // nobody is watching, and folding the two would delete that fact.
    expect(sustained.registration.renewed_at).toBe(T0);
  });

  it("leaves a drained project on its own deadline, which is how it lapses", () => {
    const drained = sustainProjectRegistration(held(), { now: T0, queue: { outcome: "counted", depth: 0 } });

    expect(drained.verdict).toBe("drained");
    expect(drained.registration).toEqual(held());
    expect(drained.detail).toMatch(/nothing queued/);
  });

  it("never sustains on a queue nobody could count, because silence is what a closed laptop makes", () => {
    for (const outcome of ["unreachable", "rate-limited"] as const) {
      const uncounted = sustainProjectRegistration(held(), { now: T0, queue: { outcome, depth: null } });
      expect(uncounted.verdict).toBe("uncounted");
      expect(uncounted.registration.renew_by).toBe(held().renew_by);
    }
    // And a project no poll covered at all is the same answer, for the same reason.
    expect(sustainProjectRegistration(held(), { now: T0 }).verdict).toBe("uncounted");
  });

  it("holds a project up on its own live Worker, even with a drained selector", () => {
    // The last Ticket is being landed: the queue reads zero and the project is
    // manifestly still draining, so a zero must not retire it mid-flight.
    const sustained = sustainProjectRegistration(held(), {
      now: T0,
      queue: { outcome: "counted", depth: 0 },
      liveWorkers: 1,
    });

    expect(sustained.verdict).toBe("live-worker");
    expect(sustained.registration.sustained_by).toBe("live-worker");
    expect(sustained.registration.renew_by).toBe(new Date(Date.parse(T0) + WINDOW_MS).toISOString());
  });

  it("says self-renewing where a session went quiet and the work did not", () => {
    const at = Date.parse(T0) + WINDOW_MS * 0.75;
    const sustained = sustainProjectRegistration(held(), {
      now: new Date(at).toISOString(),
      queue: { outcome: "counted", depth: 2 },
    });

    // Past the cadence a session renews at, so nobody is watching — but the
    // daemon is holding it up, and an operator can see WHICH of the two it is.
    expect(registrationRenewalStatus(held(), at)).toBe("running-on");
    expect(registrationRenewalStatus(sustained.registration, at)).toBe("self-renewing");
    // A session that speaks again outranks it: the verdict is about silence.
    const renewed = renewProjectRegistration(sustained.registration, { now: new Date(at).toISOString() });
    expect(registrationRenewalStatus(renewed, at)).toBe("renewing");
    // And a sustain older than the cadence stops standing in for one.
    expect(registrationRenewalStatus(sustained.registration, at + WINDOW_MS)).toBe("running-on");
  });
});

describe("a registration outlives its window while the project still drains", () => {
  it("keeps host-state and statusline reads as pure snapshots", async () => {
    const snapshots: RedskilledProjectRegistration[][] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      clock: () => T0,
      launch: recordingLaunch([]),
      registrationIntentStore: {
        read: async () => [],
        replace: async (registrations) => { snapshots.push([...registrations]); },
        flush: async () => {},
      },
    });
    running.push(daemon);
    daemon.registerProject(request());
    daemon.trackWorker({
      worker_id: "wLIVE",
      project_label: "acme/widgets",
      pid: 42,
      started_at: T0,
      workspace_path: "/tmp/acme-widgets",
      isolated: true,
      unit: "red-worker-wLIVE.service",
      warnings: [],
    });
    const before = daemon.hostState().registrations![0]!;
    const writes = snapshots.length;

    for (let index = 0; index < 100; index += 1) {
      daemon.hostState();
      daemon.statuslinePayload();
    }

    const after = daemon.hostState().registrations![0]!;
    expect(after.renewals).toBe(before.renewals);
    expect(after.sustains).toBe(before.sustains);
    expect(after.renew_by).toBe(before.renew_by);
    expect(snapshots).toHaveLength(writes);
  });

  it("survives a daemon replacement and resumes polling without project_start", async () => {
    const paths = await sessionPaths();
    const first = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([3]) },
    });
    running.push(first);

    first.registerProject(request());
    await first.pollQueueDiscovery();
    await first.stop({ reason: "replaced" });

    const successor = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([3]) },
    });
    running.push(successor);

    const polled = await successor.pollQueueDiscovery();
    expect(polled?.projects[0]?.depth).toBe(3);
    expect(successor.hostState().registrations?.[0]).toMatchObject({
      project_label: "acme/widgets",
      target: 1,
    });
  });

  it("survives replacement onto another runtime directory without project_start", async () => {
    const home = await scratch("redskilled-home-");
    const machine = await scratch("redskilled-machine-");
    const firstRuntime = await scratch("redskilled-runtime-a-");
    const secondRuntime = await scratch("redskilled-runtime-b-");
    const machineClaimPath = join(machine, "redskilled.machine.claim.toon");
    const firstPaths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: "runtime-a", REDSKILLED_MACHINE_DIR: machine },
      runtimeDir: firstRuntime,
      homeDir: home,
      machineClaimPath,
    });
    const secondPaths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: "runtime-b", REDSKILLED_MACHINE_DIR: machine },
      runtimeDir: secondRuntime,
      homeDir: home,
      machineClaimPath,
    });
    expect(firstPaths.registrationIntentPath).toBe(secondPaths.registrationIntentPath);

    const first = await startRedskilledDaemon({
      paths: firstPaths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([3]) },
    });
    running.push(first);
    first.registerProject(request());
    await first.pollQueueDiscovery();
    await first.stop({ reason: "replaced" });

    const successor = await startRedskilledDaemon({
      paths: secondPaths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([3]) },
    });
    running.push(successor);

    expect(successor.hostState().registrations?.[0]).toMatchObject({
      project_label: "acme/widgets",
      target: 1,
    });
  });

  it("keeps holding a project with open work past its deadline, with no session at all", async () => {
    const clock = testClock();
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      clock: clock.now,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject(request());
    const registered = daemon.hostState().registrations![0]!;
    // The session ends here. Nothing renews this record from now on.
    for (let tick = 0; tick < 6; tick += 1) {
      clock.advance(WINDOW_MS / 2);
      await daemon.pollQueueDiscovery();
    }

    // Three whole windows past the deadline the registration was minted with.
    expect(Date.parse(clock.now())).toBeGreaterThan(Date.parse(registered.renew_by));
    const standing = daemon.hostState().registrations![0]!;
    expect(standing.project_label).toBe("acme/widgets");
    expect(standing.renewals).toBeGreaterThanOrEqual(6);
    expect(standing.session_renewals).toBe(0);
    expect(standing.sustains).toBeGreaterThanOrEqual(6);
    expect(standing.renewal).toBe("self-renewing");
  });

  it("still births a Worker after the original window has passed", async () => {
    const launched: LaunchWorkerOptions[] = [];
    const clock = testClock();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      clock: clock.now,
      launch: recordingLaunch(launched),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject(request({ workspace_path: workspace }));
    const deadline = Date.parse(daemon.hostState().registrations![0]!.renew_by);
    for (let tick = 0; tick < 4; tick += 1) {
      clock.advance(WINDOW_MS / 2);
      await daemon.pollQueueDiscovery();
    }
    expect(Date.parse(clock.now())).toBeGreaterThan(deadline);

    const tick = await daemon.driveDemand();
    expect(tick.granted).toHaveLength(1);
    expect(daemon.workerCount()).toBe(1);
    expect(launched[0]!.spec.workspace_path).toBe(workspace);
  });

  it("sustains on its own cadence when the queue poll pauses", async () => {
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      registrationSustainMs: 20,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject(request({ renew_within_ms: 120 }));
    await daemon.pollQueueDiscovery();
    // No second queue poll. The registration's belt consumes the last fresh
    // observation on its own cadence and keeps the record past its first TTL.
    await new Promise((resolve) => setTimeout(resolve, 160));

    const standing = daemon.hostState().registrations![0]!;
    expect(standing.renewals).toBeGreaterThanOrEqual(4);
    expect(standing.renewal).toBe("self-renewing");
  });
});

describe("a project that no longer intends to drain lapses, and says so", () => {
  it("drops a drained registration at its deadline and reports the lapse with a reason", async () => {
    const clock = testClock();
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      clock: clock.now,
      launch: recordingLaunch([]),
      // Nothing queued, and no Worker was ever born: the project has finished.
      queueDiscovery: { intervalMs: 0, transport: async () => answer([0]) },
    });
    running.push(daemon);

    daemon.registerProject(request());
    clock.advance(WINDOW_MS / 2);
    await daemon.pollQueueDiscovery();
    // A drained poll sustains nothing, so the deadline stands where it was.
    expect(daemon.hostState().registrations).toHaveLength(1);

    clock.advance(WINDOW_MS);
    daemon.sweepRegistrations();
    const state = daemon.hostState();
    expect(state.registrations).toEqual([]);
    // NOT just an absence: a project missing from the set could be one that never
    // registered, and only one of the two is a drain that stopped.
    const lapse = state.lapsed_registrations![0]!;
    expect(lapse.project_label).toBe("acme/widgets");
    expect(lapse.renewals).toBe(0);
    expect(lapse.sustains).toBe(0);
    expect(lapse.detail).toMatch(/nothing renewed it/);
    expect(Date.parse(lapse.at)).toBe(Date.parse(clock.now()));
  });

  it("shows the lapse while it is stopped, then re-registers when the next poll still finds work", async () => {
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      registrationSustainMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([3]) },
    });
    running.push(daemon);

    daemon.registerProject(request({ renew_within_ms: 30 }));
    // The host first observed this project actively draining. That positive fact
    // is what entitles one bounded recovery poll after a scheduling lapse.
    await daemon.pollQueueDiscovery();
    await new Promise((resolve) => setTimeout(resolve, 50));
    daemon.sweepRegistrations();
    const lapsed = daemon.hostState();
    expect(lapsed.registrations).toEqual([]);

    const render = renderRedskilledStatusline(
      buildStatuslinePayload({
        hostState: lapsed,
        ceiling: UNBOUNDED_HOST_CEILING,
        rss: {},
        sampledAt: null,
        now: new Date().toISOString(),
      }),
      {
        ...REDSKILLED_STATUSLINE_DEFAULTS,
        project: "acme/widgets",
      },
    );
    expect(render.project_match).toBe("lapsed");
    expect(render.line).toContain("project unknown — acme/widgets lapsed at");
    expect(render.line).toContain("(registered ");
    expect(render.line).not.toContain("idle");

    const polled = await daemon.pollQueueDiscovery();
    expect(polled?.projects[0]?.depth).toBe(3);
    const recovered = daemon.hostState().registrations![0]!;
    expect(recovered.project_label).toBe("acme/widgets");
    expect(recovered.renewals).toBeGreaterThan(0);
  });

  it("keeps a declared standing drain recoverable beyond the ordinary window", async () => {
    const clock = testClock();
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      registrationSustainMs: 0,
      clock: clock.now,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([5]) },
    });
    running.push(daemon);

    daemon.registerProject(request({ standing: true }));
    await daemon.pollQueueDiscovery();

    // Miss the registration deadline and the complete ordinary recovery window.
    clock.advance(WINDOW_MS * 3);
    daemon.sweepRegistrations();
    const stopped = daemon.hostState();
    expect(stopped.registrations).toEqual([]);
    const rendered = renderRedskilledStatusline(
      buildStatuslinePayload({
        hostState: stopped,
        ceiling: UNBOUNDED_HOST_CEILING,
        rss: {},
        sampledAt: null,
        now: clock.now(),
      }),
      { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" },
    );
    expect(rendered.line).toContain("queue 5, drain STOPPED");

    const polled = await daemon.pollQueueDiscovery();
    expect(polled?.projects[0]?.depth).toBe(5);
    expect(daemon.hostState().registrations?.[0]).toMatchObject({
      project_label: "acme/widgets",
      standing: true,
      sustained_by: "open-work",
    });
  });

  it("stops being polled once it has lapsed, so an empty selector costs no request", async () => {
    const clock = testClock();
    const queried: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      clock: clock.now,
      launch: recordingLaunch([]),
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          queried.push(query);
          return answer([0]);
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(request());
    clock.advance(WINDOW_MS);
    expect(await daemon.pollQueueDiscovery()).toBeNull();
    expect(queried).toEqual([]);
  });
});

describe("a surface tells a registration from a name", () => {
  const worker = {
    worker_id: "wA1B2",
    project_label: "acme/widgets",
    pid: 4_242,
    started_at: T0,
    workspace_path: "/tmp/acme-widgets",
    isolated: false,
    warnings: [] as readonly string[],
  };

  function payloadOf(registrations: readonly string[], workers: readonly (typeof worker)[]) {
    return buildStatuslinePayload({
      hostState: buildHostState({
        daemonVersion: "0.1.0",
        machineIdHash: "mach",
        sessionKeyHash: "sess",
        pid: 99,
        startedAt: T0,
        workers,
        registrations: registrations.map((project_label) => held({ project_label })),
      }),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: "2026-07-31T12:00:00.000Z",
      now: "2026-07-31T12:00:05.000Z",
    });
  }

  const options = (overrides: Partial<RedskilledStatuslineOptions> = {}): RedskilledStatuslineOptions => ({
    ...REDSKILLED_STATUSLINE_DEFAULTS,
    project: "acme/widgets",
    ...overrides,
  });

  it("renders a held registration as the matched project it is", () => {
    const render = renderRedskilledStatusline(payloadOf(["acme/widgets"], [worker]), options());

    expect(render.project_match).toBe("matched");
    expect(render.line).toContain("1w 0B v0.1.0");
    expect(render.line).not.toContain("acme/widgets");
    expect(render.line).not.toContain("unregistered");
  });

  it("refuses to render a lapsed registration as a healthy project, even while its Worker runs", () => {
    // The label is known — it is on the Worker — and the host holds no
    // registration, so nothing will be born here again. A name is not a state.
    const render = renderRedskilledStatusline(payloadOf([], [worker]), options());

    expect(render.project_match).toBe("name-only");
    expect(render.line).toContain("1w !unregistered 0B v0.1.0");
    expect(render.line).not.toContain("acme/widgets");
    expect(render.line).toContain("!unregistered");
    expect(render.line).not.toContain("idle");
  });

  it("never invents a lapse from a daemon too old to state its registrations", () => {
    const payload = payloadOf([], [worker]);
    const { registered_projects: _dropped, ...older } = payload;

    expect(renderRedskilledStatusline(older, options()).project_match).toBe("matched");
  });
});
