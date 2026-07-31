// The daemon holds a project registration: a record it stores for each project
// that wants work done, and reports back. Nothing polls it and nothing is
// dispatched from it at this slice — what is proven here is that the record
// exists, that it survives the socket verbatim, and above all that the daemon
// never reads the two opaque strings it carries (ADR 0130 rule 3, Amendment 3).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState, registerRedskilledProject } from "../src/client.js";
import { isRedskilledHostState } from "../src/host-state.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildProjectRegistration,
  isRedskilledProjectRegistration,
  REDSKILLED_REGISTRATION_TTL_MS,
  RedskilledProjectRegisteredError,
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

/** One registration request, with only the fields a case cares about restated. */
function request(
  overrides: Partial<RedskilledProjectRegistrationRequest> = {},
): RedskilledProjectRegistrationRequest {
  return {
    project_label: "acme/widgets",
    selector: "is:open label:ready-for-agent",
    argv: ["red-skills-dev", "__work", "--selector", "ready"],
    target: 3,
    ...overrides,
  };
}

const NOW = "2026-07-31T00:00:00.000Z";

/**
 * Selectors and argvs a reader would have to treat differently.
 *
 * Every one of them would change the behaviour of a daemon that parsed the
 * string: a tracker query, a JSON document, a path traversal, a shell verb, a
 * line break the wire has to escape, and a string that reads like another
 * project's label. The daemon must answer identically to all six.
 */
const OPAQUE_SELECTORS = [
  "is:open label:ready-for-agent -label:blocked:dependency",
  '{"selector":{"labels":["ready"]},"limit":10}',
  "../../etc/passwd",
  "--target 99; rm -rf /",
  "line one\nline two\tand a tab",
  "acme/gadgets",
] as const;

const OPAQUE_ARGVS = [
  ["red-skills-dev", "__work"],
  ["node", "-e", "process.exit(0)"],
  ["/usr/bin/env", "sh", "-c", "echo $HOME > /dev/null"],
  ["cmd", "--json", '{"a":1}'],
  ["cmd", "with\nnewline"],
  ["red-skills-dev", "--project", "acme/gadgets"],
] as const;

describe("redskilled project registration", () => {
  it("reports a registered project in host state, selector and argv verbatim", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    const registered = await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    expect(isRedskilledProjectRegistration(registered.registration)).toBe(true);
    expect(registered.registration.project_label).toBe("acme/widgets");
    expect(registered.registration.target).toBe(3);

    const state = await readRedskilledHostState(paths);
    expect(isRedskilledHostState(state)).toBe(true);
    expect(state.registrations).toHaveLength(1);
    const held = state.registrations![0]!;
    expect(held.project_label).toBe("acme/widgets");
    expect(held.target).toBe(3);
    // Verbatim, both of them: what the client handed over is what comes back.
    expect(held.selector).toBe("is:open label:ready-for-agent");
    expect(held.argv).toEqual(["red-skills-dev", "__work", "--selector", "ready"]);
    expect(Date.parse(held.renew_by)).toBeGreaterThan(Date.parse(held.registered_at));
    // A registration is a record, not a Worker: nothing was born by holding one.
    expect(state.workers).toEqual([]);
    expect(daemon.workerCount()).toBe(0);
  });

  it("never branches on the content of a selector or an argv", () => {
    // Every registration is built from the same request but for the swapped
    // strings. If any of the six changed a single other field — the target, the
    // deadline, the label, the acceptance itself — the daemon read one of them.
    const built = OPAQUE_SELECTORS.map((selector, index) =>
      buildProjectRegistration(request({ selector, argv: [...OPAQUE_ARGVS[index]!] }), { now: NOW }),
    );

    for (const [index, registration] of built.entries()) {
      expect(registration.selector).toBe(OPAQUE_SELECTORS[index]);
      expect(registration.argv).toEqual([...OPAQUE_ARGVS[index]!]);
      // Everything the daemon DOES decide is decided identically.
      expect({ ...registration, selector: "", argv: [] }).toEqual({
        ...built[0]!,
        selector: "",
        argv: [],
      });
    }
  });

  it("carries an opaque selector and argv across the socket unchanged", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    // The wire is line-delimited JSON, so a selector with a newline in it is the
    // case that proves transport is not semantics.
    const selector = OPAQUE_SELECTORS[4];
    const argv = [...OPAQUE_ARGVS[4]!];
    await registerRedskilledProject(paths, request({ selector, argv }), { sessionProject: "acme/widgets" });

    const state = await readRedskilledHostState(paths);
    expect(state.registrations![0]!.selector).toBe(selector);
    expect(state.registrations![0]!.argv).toEqual(argv);
  });

  it("orders registrations by project label alone", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    // Registered in an order the labels do not have, with selectors that sort the
    // other way: the document is ordered by the one field the daemon may read.
    daemon.registerProject(request({ project_label: "b/two", selector: "aaa" }));
    daemon.registerProject(request({ project_label: "a/one", selector: "zzz" }));

    expect(daemon.hostState().registrations!.map((held) => held.project_label)).toEqual(["a/one", "b/two"]);
  });

  it("refuses a second registration for the same project, naming the one it holds", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    await registerRedskilledProject(paths, request(), { sessionProject: "acme/widgets" });
    await expect(
      registerRedskilledProject(paths, request({ target: 9, selector: "something else" }), {
        sessionProject: "acme/widgets",
      }),
    ).rejects.toThrow(/acme\/widgets/);

    // The refusal names the registration that is standing, and nothing changed.
    const state = await readRedskilledHostState(paths);
    expect(state.registrations).toHaveLength(1);
    expect(state.registrations![0]!.target).toBe(3);
    expect(state.registrations![0]!.selector).toBe("is:open label:ready-for-agent");
  });

  it("names the standing registration in the conflict it throws", () => {
    const held = buildProjectRegistration(request(), { now: NOW });
    let thrown: unknown;
    try {
      buildProjectRegistration(request({ target: 9 }), { now: NOW, held });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RedskilledProjectRegisteredError);
    const error = thrown as RedskilledProjectRegisteredError;
    expect(error.held).toEqual(held);
    expect(error.message).toContain("acme/widgets");
    expect(error.message).toContain(held.registered_at);
  });

  it("registers into the session's own project and refuses another one", async () => {
    expect(REDSKILLED_OP_REACH["project-register"]).toBe("project-write");
    const refused = evaluateSessionReach({
      op: "project-register",
      sessionProject: "acme/widgets",
      targetProject: "acme/gadgets",
    });
    expect(refused.permitted).toBe(false);
    expect(refused.verdict).toBe("refused-cross-project");

    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);
    await expect(
      registerRedskilledProject(paths, request({ project_label: "acme/gadgets" }), {
        sessionProject: "acme/widgets",
      }),
    ).rejects.toThrow(/acme\/gadgets/);
    expect(daemon.hostState().registrations).toEqual([]);
  });

  it("checks the shape of a registration and never its meaning", () => {
    expect(() => buildProjectRegistration(request({ project_label: "" }), { now: NOW })).toThrow(/project label/);
    expect(() => buildProjectRegistration(request({ selector: "" }), { now: NOW })).toThrow(/selector/);
    expect(() => buildProjectRegistration(request({ argv: [] }), { now: NOW })).toThrow(/argv/);
    expect(() => buildProjectRegistration(request({ target: -1 }), { now: NOW })).toThrow(/target/);
    expect(() => buildProjectRegistration(request({ target: 1.5 }), { now: NOW })).toThrow(/target/);
    expect(() => buildProjectRegistration(request({ renew_within_ms: 0 }), { now: NOW })).toThrow(/renew/);

    // A target of zero is a project that wants nothing right now, not a fault.
    expect(buildProjectRegistration(request({ target: 0 }), { now: NOW }).target).toBe(0);
    const defaulted = buildProjectRegistration(request(), { now: NOW });
    expect(defaulted.renew_within_ms).toBe(REDSKILLED_REGISTRATION_TTL_MS);
    expect(defaulted.renew_by).toBe(new Date(Date.parse(NOW) + REDSKILLED_REGISTRATION_TTL_MS).toISOString());
  });

  it("accepts an older daemon's answer that carries no registrations block", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    const { registrations: _dropped, ...older } = daemon.hostState();
    // Exactly the tolerance the scope and upgrade blocks already get: one daemon
    // serves checkouts pinned to different bundle versions, so a block this
    // bundle added must not make an older daemon's complete answer malformed.
    expect(isRedskilledHostState(older)).toBe(true);
    expect(isRedskilledHostState({ ...older, registrations: "not a list" })).toBe(false);
    expect(isRedskilledHostState({ ...older, registrations: [{ project_label: "acme/widgets" }] })).toBe(false);
  });
});
