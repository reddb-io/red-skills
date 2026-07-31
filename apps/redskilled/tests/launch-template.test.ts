// A Worker's runner, model and effort are decided per birth, and Amendment 4
// hands the daemon ONE argv per project. What is proven here is that the
// capability survives the move: the launch is restated on the renewal a live
// session already sends (Amendment 5), the per-birth facts arrive as
// placeholders the daemon fills from facts it owns, and the daemon reads none of
// the words it carries — a template mentioning a runner, a model and an effort
// produces byte-identical daemon decisions to one mentioning none of them.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRedskilledHostState,
  registerRedskilledProject,
  renewRedskilledProject,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  expandLaunchTemplate,
  RedskilledLaunchFactError,
  REDSKILLED_LAUNCH_FACTS,
  workerSpecFromLaunch,
  type RedskilledLaunchTemplate,
} from "../src/launch-template.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildProjectRegistration,
  renewProjectRegistration,
  type RedskilledProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "../src/project-registration.js";

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

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-07-31T00:02:30.000Z";

/** The launch a project states while its runner is `runner`. */
function launch(runner: string): RedskilledLaunchTemplate {
  return {
    argv: ["/usr/bin/node", "/bundle.mjs", "run", "--once", "--runner", runner],
    env: {
      RED_AFK_RUNNER: runner,
      RED_AFK_SLOT: "{{slot}}",
      RED_AFK_WORKER_ID: "{{worker_id}}",
      RED_AFK_RETIRE_FILE: "/state/afk-supervisor-slot-{{slot}}.retire",
    },
  };
}

function request(
  overrides: Partial<RedskilledProjectRegistrationRequest> = {},
): RedskilledProjectRegistrationRequest {
  const stated = launch("claude");
  return {
    project_label: "acme/widgets",
    selector: "is:open label:ready-for-agent",
    argv: stated.argv,
    env: stated.env,
    workspace_path: "/repo",
    target: 3,
    ...overrides,
  };
}

/** The launch a registration is standing on, as a template again. */
function standing(registration: RedskilledProjectRegistration): RedskilledLaunchTemplate {
  return { argv: registration.argv, env: registration.env };
}

describe("expanding a launch template", () => {
  it("writes the daemon's own facts into the argv and the env", () => {
    const expanded = expandLaunchTemplate(
      {
        argv: ["/usr/bin/node", "/bundle.mjs", "--worker", "{{worker_id}}", "--log", "{{log_path}}"],
        env: { RED_AFK_SLOT: "{{slot}}", CWD: "{{workspace_path}}" },
      },
      { worker_id: "wZ2R4", slot: 2, workspace_path: "/repo", log_path: "/logs/w.log" },
    );

    expect(expanded.argv).toEqual(["/usr/bin/node", "/bundle.mjs", "--worker", "wZ2R4", "--log", "/logs/w.log"]);
    expect(expanded.env).toEqual({ RED_AFK_SLOT: "2", CWD: "/repo" });
  });

  it("copies a word that mentions no fact, verbatim", () => {
    // Every one of these is a word a reader would be tempted to interpret. The
    // expansion is textual and total, so each comes out exactly as it went in.
    const words = [
      "--runner",
      "codex",
      "--model=claude-opus-5",
      "--effort",
      "xhigh",
      "{ not a placeholder }",
      "--selector=is:open label:ready-for-agent",
    ];
    const expanded = expandLaunchTemplate({ argv: words }, {
      worker_id: "wAAAA",
      slot: 0,
      workspace_path: "/repo",
    });
    expect(expanded.argv).toEqual(words);
    expect(expanded.env).toEqual({});
  });

  it("refuses a fact it does not have rather than starting a Worker with the placeholder", () => {
    expect(() =>
      expandLaunchTemplate({ argv: ["/bin/run", "--tier", "{{tier}}"] }, {
        worker_id: "wAAAA",
        slot: 0,
        workspace_path: "/repo",
      })
    ).toThrow(RedskilledLaunchFactError);

    // The refusal names the fact and the ones the daemon does have, because the
    // shape of this mistake is a typo in a client.
    try {
      expandLaunchTemplate({ argv: ["/bin/run"], env: { X: "{{effort}}" } }, {
        worker_id: "wAAAA",
        slot: 0,
        workspace_path: "/repo",
      });
      expect.unreachable("an unknown fact must fail closed");
    } catch (err) {
      expect((err as Error).message).toContain("{{effort}}");
      for (const fact of REDSKILLED_LAUNCH_FACTS) expect((err as Error).message).toContain(fact);
    }
  });

  it("composes the slot-scoped env per birth, not once per project", () => {
    const template = standing(buildProjectRegistration(request(), { now: NOW }));
    const first = workerSpecFromLaunch(template, {
      worker_id: "wAAAA",
      slot: 0,
      workspace_path: "/repo",
    }, { project_label: "acme/widgets" });
    const second = workerSpecFromLaunch(template, {
      worker_id: "wBBBB",
      slot: 1,
      workspace_path: "/repo",
    }, { project_label: "acme/widgets" });

    // One registration, two Workers, and every per-birth field differs — a retire
    // file two Workers shared would retire the wrong one.
    expect(first.env.RED_AFK_SLOT).toBe("0");
    expect(second.env.RED_AFK_SLOT).toBe("1");
    expect(first.env.RED_AFK_WORKER_ID).toBe("wAAAA");
    expect(second.env.RED_AFK_WORKER_ID).toBe("wBBBB");
    expect(first.env.RED_AFK_RETIRE_FILE).toBe("/state/afk-supervisor-slot-0.retire");
    expect(second.env.RED_AFK_RETIRE_FILE).toBe("/state/afk-supervisor-slot-1.retire");
    // The id on the spec and the id in the env are ONE string; a Worker the host
    // and the work disagree about is one neither can be asked about.
    expect(first.worker_id).toBe(first.env.RED_AFK_WORKER_ID);
  });

  it("reads the command off the argv's first word and the arguments off the rest", () => {
    const spec = workerSpecFromLaunch(launch("codex"), {
      worker_id: "wCCCC",
      slot: 0,
      workspace_path: "/repo",
      log_path: "/logs/w.log",
    }, { project_label: "acme/widgets" });

    expect(spec.command).toBe("/usr/bin/node");
    expect(spec.args).toEqual(["/bundle.mjs", "run", "--once", "--runner", "codex"]);
    expect(spec.workspace_path).toBe("/repo");
    expect(spec.log_path).toBe("/logs/w.log");
  });
});

describe("restating a launch", () => {
  it("changes the runner of the NEXT Worker without a re-registration", () => {
    const registered = buildProjectRegistration(request(), { now: NOW });

    // A Worker born before the directive lands is born on the runner that stood.
    const before = workerSpecFromLaunch(standing(registered), {
      worker_id: "wAAAA",
      slot: 0,
      workspace_path: "/repo",
    }, { project_label: registered.project_label });
    expect(before.args).toContain("claude");
    expect(before.env.RED_AFK_RUNNER).toBe("claude");

    // The directive lands mid-drain and rides the renewal the session already
    // sends. No deregistration, so the host never stops holding this project.
    const renewed = renewProjectRegistration(registered, { now: LATER, launch: launch("codex") });

    const after = workerSpecFromLaunch(standing(renewed), {
      worker_id: "wBBBB",
      slot: 1,
      workspace_path: "/repo",
    }, { project_label: renewed.project_label });
    expect(after.args).toEqual(["/bundle.mjs", "run", "--once", "--runner", "codex"]);
    expect(after.env.RED_AFK_RUNNER).toBe("codex");

    // The Worker already running keeps the runner it was born with: a directive
    // changes the next birth, never a process in flight.
    expect(before.args).toContain("claude");

    // Everything about the WORK is carried over untouched — a renewal is not a
    // second chance to restate what work this project wants.
    expect(renewed.selector).toBe(registered.selector);
    expect(renewed.target).toBe(registered.target);
    expect(renewed.registered_at).toBe(registered.registered_at);
    // The revisions answer two different questions, and both moved once.
    expect(renewed.renewals).toBe(1);
    expect(renewed.launch_revision).toBe(1);
  });

  it("leaves the launch standing when a renewal restates nothing", () => {
    const registered = buildProjectRegistration(request(), { now: NOW });
    const renewed = renewProjectRegistration(registered, { now: LATER });

    expect(renewed.argv).toEqual(registered.argv);
    expect(renewed.env).toEqual(registered.env);
    // Renewals move; the launch revision does not — the next Worker is the one
    // this project last asked for.
    expect(renewed.renewals).toBe(1);
    expect(renewed.launch_revision).toBe(0);
  });

  it("replaces a launch whole, so no Worker is born half from each tick", () => {
    const registered = buildProjectRegistration(request(), { now: NOW });
    const renewed = renewProjectRegistration(registered, {
      now: LATER,
      launch: { argv: ["/usr/bin/node", "/bundle.mjs", "run", "--once", "--runner", "codex"] },
    });

    // An argv restated without an env leaves no env behind: a launch half from
    // one decision and half from an older one is a Worker neither tick asked for.
    expect(renewed.env).toEqual({});
    expect(renewed.launch_revision).toBe(1);
  });

  it("carries a restated launch across the socket and reports it back", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    const renewed = await renewRedskilledProject(
      paths,
      { project_label: "acme/widgets", launch: launch("codex") },
      { sessionProject: "acme/widgets" },
    );

    expect(renewed.registration.argv).toEqual(launch("codex").argv);
    expect(renewed.registration.env.RED_AFK_RUNNER).toBe("codex");
    // The placeholders survive the wire unexpanded: they are filled at birth, by
    // the daemon, from facts that do not exist yet at renewal time.
    expect(renewed.registration.env.RED_AFK_SLOT).toBe("{{slot}}");
    expect(renewed.registration.launch_revision).toBe(1);

    const state = await readRedskilledHostState(paths);
    expect(state.registrations![0]!.argv).toEqual(launch("codex").argv);
  });
});

describe("what the daemon does not read", () => {
  // Four launches a reader would have to treat differently — different runners,
  // an explicit model, an effort, a flag that looks like a daemon knob. If the
  // daemon read any of them, one of these would be handled unlike the others.
  const LAUNCHES: readonly RedskilledLaunchTemplate[] = [
    launch("claude"),
    launch("codex"),
    { argv: ["/usr/bin/node", "/b.mjs", "--model", "claude-opus-5", "--effort", "xhigh"], env: { M: "opus" } },
    { argv: ["/usr/bin/node", "/b.mjs", "--target", "99", "--budget", "0"], env: { E: "low" } },
  ];

  it("never branches on a runner, a model or an effort when it holds a launch", () => {
    const built = LAUNCHES.map((stated) =>
      buildProjectRegistration(request({ argv: stated.argv, env: stated.env }), { now: NOW }),
    );

    for (const [index, registration] of built.entries()) {
      expect(registration.argv).toEqual(LAUNCHES[index]!.argv);
      expect(registration.env).toEqual(LAUNCHES[index]!.env);
      // Everything the daemon DOES decide is decided identically. A target read
      // off an argv word, a deadline shortened for a "big" model, an acceptance
      // refused for an unknown runner — any of them would show up right here.
      expect({ ...registration, argv: [], env: {} }).toEqual({ ...built[0]!, argv: [], env: {} });
    }
  });

  it("never branches on a launch when it restates one", () => {
    const registered = buildProjectRegistration(request(), { now: NOW });
    const renewed = LAUNCHES.map((stated) => renewProjectRegistration(registered, { now: LATER, launch: stated }));

    for (const [index, registration] of renewed.entries()) {
      expect(registration.argv).toEqual(LAUNCHES[index]!.argv);
      expect({ ...registration, argv: [], env: {} }).toEqual({ ...renewed[0]!, argv: [], env: {} });
    }
  });

  it("never branches on a launch when it expands one", () => {
    const facts = { worker_id: "wAAAA", slot: 3, workspace_path: "/repo" };
    const specs = LAUNCHES.map((stated) => workerSpecFromLaunch(stated, facts, { project_label: "acme/widgets" }));

    for (const spec of specs) {
      // The daemon's own decisions about a birth — where it runs, what it is
      // called, whose it is — are the same for every one of these launches.
      expect({ ...spec, command: "", args: [], env: {} }).toEqual({
        ...specs[0]!,
        command: "",
        args: [],
        env: {},
      });
    }
    // And the words themselves came through untouched.
    expect(specs[2]!.args).toEqual(["/b.mjs", "--model", "claude-opus-5", "--effort", "xhigh"]);
  });
});
