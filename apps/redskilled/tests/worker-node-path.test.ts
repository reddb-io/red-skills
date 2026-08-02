// The daemon hands its own node down to every Worker it births (#3064).
//
// A Worker born into a transient unit inherits the init system's canonical
// system PATH, so on a version-manager host (mise, nvm, asdf, volta) — where
// node lives only under the manager's install root — every system tool resolves
// and node alone goes missing. The daemon deciding that is itself running on the
// node it failed to pass on, and `process.execPath` is that answer.
import { describe, expect, it } from "vitest";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { launchWorker } from "../src/worker-launch.js";
import type { WorkerPlacementProbes } from "../src/worker-placement.js";

const ADMITTED = evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] });

const LINUX_WITH_SESSION: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
  jobObjects: { available: false, reason: "not Windows" },
  posix: { available: false, reason: "not macOS" },
};

const LINUX_NO_SESSION: WorkerPlacementProbes = { ...LINUX_WITH_SESSION, userSession: false };

/** The operator's node, reachable through no system directory. */
const MISE_NODE = "/home/posed/.local/share/mise/installs/node/lts/bin/node";
const MISE_BIN = "/home/posed/.local/share/mise/installs/node/lts/bin";
/** What a systemd --user unit's PATH looks like: six of seven tools, no node. */
const SANITIZED_PATH = "/usr/local/bin:/usr/bin:/bin";

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

function launch(probes: WorkerPlacementProbes, specEnv?: Record<string, string>): Spawned {
  const spawns: Spawned[] = [];
  launchWorker({
    admission: ADMITTED,
    spec: {
      project_label: "acme/widgets",
      workspace_path: "/tmp/posed-workspace",
      command: "/bin/true",
      ...(specEnv != null ? { env: specEnv } : {}),
    },
    probes,
    env: { PATH: SANITIZED_PATH },
    execPath: MISE_NODE,
    openLog: false,
    spawnFn: (command, args, options) => {
      spawns.push({ command, args, env: options.env });
      return { pid: 4242, once: () => undefined, unref: () => undefined } as never;
    },
  });
  expect(spawns).toHaveLength(1);
  return spawns[0]!;
}

describe("the Worker's PATH carries the node the daemon runs on", () => {
  it("sets it on the transient unit, where the sanitized PATH has no node", () => {
    const spawned = launch(LINUX_WITH_SESSION);

    expect(spawned.args).toContain(`--setenv=PATH=${MISE_BIN}:${SANITIZED_PATH}`);
  });

  it("sets it on an unisolated launch too, where the spawn env is the Worker's", () => {
    const spawned = launch(LINUX_NO_SESSION);

    expect(spawned.env?.PATH).toBe(`${MISE_BIN}:${SANITIZED_PATH}`);
  });

  it("keeps a client-declared PATH and still puts the engine's node first", () => {
    const spawned = launch(LINUX_NO_SESSION, { PATH: "/opt/tools/bin", RED_POSED: "1" });

    expect(spawned.env?.PATH).toBe(`${MISE_BIN}:/opt/tools/bin`);
    expect(spawned.env?.RED_POSED).toBe("1");
  });

  it("does not duplicate the directory when the PATH already carried it", () => {
    const spawns: Spawned[] = [];
    launchWorker({
      admission: ADMITTED,
      spec: { project_label: "acme/widgets", workspace_path: "/tmp/posed-workspace", command: "/bin/true" },
      probes: LINUX_NO_SESSION,
      env: { PATH: `/usr/bin:${MISE_BIN}:/bin` },
      execPath: MISE_NODE,
      openLog: false,
      spawnFn: (command, args, options) => {
        spawns.push({ command, args, env: options.env });
        return { pid: 4242, once: () => undefined, unref: () => undefined } as never;
      },
    });

    expect(spawns[0]!.env?.PATH).toBe(`${MISE_BIN}:/usr/bin:/bin`);
  });
});
