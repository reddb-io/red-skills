// Presence: what `/red-setup` sees when it walks up to a machine that may
// already be provisioned.
//
// Setup has always had the facts and never said them, so re-running it on a
// working host asked the same questions as a fresh install. Three states have to
// be distinguishable — a daemon that answers, a half-provisioned host, and a
// machine with nothing on it — and the middle one must not collapse into either
// extreme. The detection is READ-ONLY: it observes a daemon, it never starts one
// as a side effect of looking.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDSKILLED_HOME_MODE, redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { runProvision } from "../src/cli.js";
import {
  describeRedskilledPresence,
  readRedskilledProvisionFacts,
  type RedskilledProvisionFacts,
} from "../src/provision.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const dir = await root("redskilled-presence-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${dir}`, REDSKILLED_MACHINE_DIR: dir },
    runtimeDir: dir,
  });
}

/** Healthy facts; each test spoils exactly the one thing it is about. */
function facts(overrides: Partial<RedskilledProvisionFacts> = {}): RedskilledProvisionFacts {
  return {
    homePath: "/home/dev/.red/redskilled",
    homePresent: true,
    homeMode: REDSKILLED_HOME_MODE,
    entry: { command: "/usr/bin/node", args: ["/bundles/redskilled.bundle.min.mjs"], source: "bundle-cache" },
    socketPath: "/run/user/1000/red-skills/redskilled.sock",
    reachable: true,
    daemon: { version: "3.0.4", pid: 533336 },
    supervisorUnit: "absent",
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("presence of a daemon already running", () => {
  it("reports version, pid and socket rather than asking again", () => {
    const report = describeRedskilledPresence(facts());

    expect(report.presence).toBe("running");
    expect(report.headline).toBe("redskilled detected and running — 3.0.4, pid 533336");
    expect(report.lines).toContain("  socket  /run/user/1000/red-skills/redskilled.sock");
    expect(report.lines).toContain("  reach   ok");
    // The whole point of the slice: setup has its answer and must not re-ask.
    expect(report.reinterview).toBe(false);
  });

  it("still reports a running daemon that cannot name its own version", () => {
    const report = describeRedskilledPresence(facts({ daemon: undefined }));

    expect(report.presence).toBe("running");
    expect(report.headline).toContain("detected and running");
    expect(report.reinterview).toBe(false);
  });

  it("names a home that drifted wider, without demoting a daemon that answers", () => {
    const report = describeRedskilledPresence(facts({ homeMode: 0o755 }));

    expect(report.presence).toBe("running");
    expect(report.lines.join("\n")).toContain("/home/dev/.red/redskilled");
  });
});

describe("presence of a host that is only half there", () => {
  it("reports home-present-daemon-unreachable as exactly that, not as either extreme", () => {
    const report = describeRedskilledPresence(facts({ reachable: false, daemon: undefined }));

    expect(report.presence).toBe("partial");
    expect(report.headline).toContain("home present");
    expect(report.headline).toContain("no daemon");
    // Half a host still owes the operator the rest of the interview.
    expect(report.reinterview).toBe(true);
    expect(report.lines.join("\n")).toContain("/home/dev/.red/redskilled");
  });

  it("counts a reachable daemon with no home as running, because reach is the live fact", () => {
    expect(describeRedskilledPresence(facts({ homePresent: false, homeMode: undefined })).presence).toBe("running");
  });
});

describe("presence of a machine with nothing on it", () => {
  it("walks the full path when neither the home nor a daemon is there", () => {
    const report = describeRedskilledPresence(facts({
      homePresent: false,
      homeMode: undefined,
      reachable: false,
      daemon: undefined,
      entry: { searched: ["/home/dev/.cache/red-skills/bundles"], diagnostic: "redskilled-daemon-entry-unresolved" },
    }));

    expect(report.presence).toBe("absent");
    expect(report.reinterview).toBe(true);
    expect(report.headline).toContain("not provisioned");
  });
});

describe("detection observes and never provisions", () => {
  it("reads a live daemon's version and pid off a ping", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, daemonVersion: "9.9.9-test" });
    running.push(daemon);

    const home = await root("redskilled-presence-home-");
    const observed = await readRedskilledProvisionFacts({ paths, homeDir: home, configHome: join(home, ".config") });

    expect(observed.reachable).toBe(true);
    expect(observed.daemon).toEqual({ version: "9.9.9-test", pid: process.pid });
    expect(describeRedskilledPresence(observed).presence).toBe("running");
    // Looking created nothing: the home is still the daemon's to create.
    expect(await exists(redskilledHomeDir(home))).toBe(false);
  });

  it("starts no daemon on a session nobody is serving", async () => {
    const paths = await sessionPaths();
    const home = await root("redskilled-presence-cold-");

    const observed = await readRedskilledProvisionFacts({ paths, homeDir: home, configHome: join(home, ".config") });

    expect(observed.reachable).toBe(false);
    expect(observed.daemon).toBeUndefined();
    expect(await exists(paths.socketPath)).toBe(false);
    expect(await exists(redskilledHomeDir(home))).toBe(false);
  });

  it("`provision --check` prints the presence and leaves the machine as it found it", async () => {
    const paths = await sessionPaths();
    const home = await root("redskilled-presence-check-");
    let out = "";

    const code = await runProvision(["--check"], {
      write: (text) => {
        out += text;
      },
      paths,
      homeDir: home,
      configHome: join(home, ".config"),
    });

    expect(code).toBe(1);
    expect(out).toContain("presence: absent");
    expect(await exists(redskilledHomeDir(home))).toBe(false);
    expect(await exists(paths.socketPath)).toBe(false);
  });

  it("`provision --check` names the daemon it found, without starting one", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, daemonVersion: "9.9.9-test" });
    running.push(daemon);
    const home = await root("redskilled-presence-live-");
    let out = "";

    await runProvision(["--check"], {
      write: (text) => {
        out += text;
      },
      paths,
      homeDir: home,
      configHome: join(home, ".config"),
    });

    expect(out).toContain("presence: running");
    expect(out).toContain("9.9.9-test");
    expect(out).toContain(String(process.pid));
    expect(await readdir(redskilledHomeDir(home)).catch(() => undefined)).toBeUndefined();
  });
});
