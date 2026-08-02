// The project's side of the cutover (#2851, ADR 0130): a Worker a PROJECT asked
// for is born by the daemon, appears in host state under that project's label,
// and its death reaches the project as a host event carrying the exit status.
//
// The daemon under test is the real one, started in-process on a scratch session
// socket. A mock would answer whatever the assertion wanted, and the fact worth
// proving here is precisely that a second process now does the launching.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "@reddb-io/redskilled/daemon";
import { resolveRedskilledPaths, type RedskilledPaths } from "@reddb-io/redskilled/paths";
import { describeRedskilledPresence, RedskilledUnreachableError } from "@reddb-io/redskilled/client";
import {
  createRedskilledBirthPort,
  redskilledRegistrationRefusal,
  redskilledUnreachableAdvice,
  resolveProjectLabel,
} from "../src/runtime/redskilled-birth.js";

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
  const root = await scratch("dev-birth-session-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** Wait for `probe` to hold, or fail with what it last saw. */
async function until<T>(probe: () => Promise<T | null>, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("a project's Worker is born by the daemon", () => {
  it("runs in the workspace the project named and appears in host state under its label", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("dev-birth-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const port = createRedskilledBirthPort({ root: workspace, projectLabel: "acme/widgets", paths });
    const granted = await port.start({
      worker_id: "wTEST",
      project_label: "",
      workspace_path: workspace,
      log_path: join(workspace, "worker.log"),
      command: process.execPath,
      args: ["-e", "console.log('[afk] worker: wTEST'); require('node:fs').writeFileSync('proof.txt', process.cwd());"],
    });

    expect(granted.workerId).toBe("wTEST");
    expect(granted.pid).toBeGreaterThan(0);

    // The Worker ran where the project said, and its output reached the log the
    // project named — the two facts a project loses first when it stops spawning.
    const cwd = await until(
      () => readFile(join(workspace, "proof.txt"), "utf8").then((t) => t.trim()).catch(() => null),
      "the Worker to write its proof file",
    );
    expect(cwd).toBe(workspace);
    const log = await until(
      () => readFile(join(workspace, "worker.log"), "utf8").then((t) => (t.includes("wTEST") ? t : null)).catch(() => null),
      "the Worker's stdout to reach the log the project named",
    );
    expect(log).toContain("[afk] worker: wTEST");
  });

  it("reports the Worker's death to the project with the exit status the host witnessed", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("dev-birth-death-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const port = createRedskilledBirthPort({ root: workspace, projectLabel: "acme/widgets", paths });
    await port.start({
      worker_id: "wDEAD",
      project_label: "",
      workspace_path: workspace,
      command: process.execPath,
      args: ["-e", "process.exit(78);"],
    });

    const death = await until(async () => {
      const events = await port.drainEvents();
      return events.find((event) => event.event === "worker-death" && event.worker_id === "wDEAD") ?? null;
    }, "the host to report the Worker's death");

    // The number, not the sentence: the project's policy turns on the exit code,
    // so it must arrive structurally rather than inside the daemon's prose.
    expect(death.exit_code).toBe(78);
    expect(death.project_label).toBe("acme/widgets");
  });

  it("drains each host event exactly once, so a death is never counted twice", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("dev-birth-drain-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const port = createRedskilledBirthPort({ root: workspace, projectLabel: "acme/widgets", paths });
    await port.start({
      worker_id: "wONCE",
      project_label: "",
      workspace_path: workspace,
      command: process.execPath,
      args: ["-e", "process.exit(0);"],
    });

    await until(async () => {
      const events = await port.drainEvents();
      return events.some((event) => event.event === "worker-death") ? true : null;
    }, "the host to report the Worker's death");

    expect(await port.drainEvents()).toEqual([]);
  });

  it("refuses a birth when no daemon answers, rather than spawning one itself", async () => {
    const workspace = await scratch("dev-birth-silent-");
    const unreachable = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${workspace}`, REDSKILLED_MACHINE_DIR: workspace },
      runtimeDir: workspace,
    });

    const port = createRedskilledBirthPort({
      root: workspace,
      projectLabel: "acme/widgets",
      paths: unreachable,
      // No published bundle to auto-spawn from, and none invented: fail closed.
      config: { entryLookup: {}, readyTimeoutMs: 250 },
    });

    await expect(port.start({
      project_label: "",
      workspace_path: workspace,
      command: process.execPath,
      args: ["-e", "process.exit(0);"],
    })).rejects.toThrow(/redskilled/i);
  });
});

describe("a project's registration outlives the session that made it", () => {
  it("renews while the session lives, and is refused once the record has lapsed", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("dev-birth-registration-");
    let ms = Date.parse("2026-07-31T12:00:00.000Z");
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      clock: () => new Date(ms).toISOString(),
    });
    running.push(daemon);

    const port = createRedskilledBirthPort({ root: workspace, projectLabel: "acme/widgets", paths });
    const registered = await port.register({
      selector: "is:open label:ready-for-agent",
      argv: ["red-skills-dev", "__work"],
      workspace_path: workspace,
      target: 2,
      renew_within_ms: 60_000,
    });
    expect(registered.renewals).toBe(0);

    // The session is still here, so it says so — and the record's deadline moves.
    ms += 30_000;
    const renewed = await port.renew();
    expect(renewed.renewals).toBe(1);
    expect(Date.parse(renewed.renew_by)).toBeGreaterThan(Date.parse(registered.renew_by));

    // The session ends here. One window of silence later the record is gone, and
    // renewing it is refused rather than quietly minting an argv nobody restated.
    ms += 60_000;
    await expect(port.renew()).rejects.toThrow(/acme\/widgets/);
    expect(daemon.hostState().registrations).toEqual([]);
  });
});

describe("the project's identity and its advice", () => {
  it("resolves a label for a checkout with no git, no remote and no declared name", async () => {
    const root = await scratch("dev-birth-label-");
    expect(resolveProjectLabel(root)).not.toBe("");
  });

  it("names the socket and the repair in one sentence", () => {
    const advice = redskilledUnreachableAdvice("/run/user/1/redskilled.sock", new Error("boom"));
    expect(advice).toContain("/run/user/1/redskilled.sock");
    expect(advice).toContain("redskilled provision");
    expect(advice).toContain("boom");
  });

  it("never advises provisioning a daemon a live pid is already holding", () => {
    // #3092: the reach established that pid 900870 holds the socket and did not
    // answer. Telling an operator to install one sends them to reinstall what is
    // already serving — the sentence that cost three rounds of ps/ss to see past.
    const socketPath = "/run/user/1/redskilled.sock";
    const presence = describeRedskilledPresence({
      socketPath,
      answers: false,
      lease: {
        version: 1,
        pid: 900_870,
        start_time: "2026-08-02T17:04:25.362Z",
        session_key_hash: "aaa",
        machine_id_hash: "bbb",
        socket_path: socketPath,
        acquired_at: "2026-08-02T17:04:25.362Z",
        renewed_at: "2026-08-02T17:04:25.362Z",
      },
      holderAlive: true,
      now: "2026-08-02T21:47:51.362Z",
    });
    const advice = redskilledUnreachableAdvice(
      socketPath,
      new RedskilledUnreachableError(socketPath, new Error("no answer"), presence),
    );

    expect(advice).toContain("900870");
    expect(advice).toContain("Do not provision");
    expect(advice).not.toContain("redskilled provision");
    // The same discrimination on the registration refusal, which is a sibling
    // sentence rather than a reuse of this one.
    expect(redskilledRegistrationRefusal(
      socketPath,
      new RedskilledUnreachableError(socketPath, new Error("no answer"), presence),
    )).toContain("Do not provision");
  });
});
