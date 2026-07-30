// The daemon supervises its own life: a user unit revives it (ADR 0130 rule 7,
// Q18), and auto-spawn stays the floor for a host that never installs one.
//
// Auto-spawn shipped alone, so a daemon that died mid-flight came back only when
// some client next happened to want work — and it is the one component whose
// absence stops every project on the machine. These checks pin what makes the
// unit trustworthy rather than merely present:
//
//   1. the unit's ExecStart is the PUBLISHED BUNDLE with this session's paths —
//      the same argv a client spawns, never the caller's own entry;
//   2. `Restart=on-failure` is declared, and the install actually enables it NOW;
//   3. a killed daemon driven only by that ExecStart comes BACK, with no client
//      asking for work in between;
//   4. a host with no unit still gets a daemon, and says so rather than reading
//      as broken.
//
// The supervisor is stood in for rather than assumed: the test runs the unit's own
// ExecStart when the process dies, which is exactly what `Restart=on-failure`
// does — and it proves the rendered argv works, which a systemd-only test on a
// host without a user session could never do.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRedskilledDaemon,
  REDSKILLED_BUNDLE_ASSET,
  type RedskilledClientConfig,
} from "../src/client.js";
import { socketAnswers } from "../src/daemon.js";
import { RedskilledDaemonEntryError } from "../src/daemon-entry.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import { REDSKILLED_REPLACE_EXIT_CODE } from "../src/self-replace.js";
import {
  installRedskilledUnit,
  planRedskilledUnit,
  readRedskilledUnitStatus,
  redskilledUnitPath,
  REDSKILLED_SUPERVISED_ENV,
  REDSKILLED_UNIT_NAME,
  uninstallRedskilledUnit,
  type RedskilledUnitRunResult,
} from "../src/supervision.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

/** The version baked into the fake published bundle — deliberately not the caller's. */
const PUBLISHED_VERSION = "9.9.9-published";

const children: ChildProcess[] = [];
const roots: string[] = [];
const started: string[] = [];

afterEach(async () => {
  for (const socketPath of started.splice(0)) {
    await sendRedskilledRequest({ socketPath }, { id: `shutdown-${socketPath.length}`, op: "shutdown" }).catch(
      () => undefined,
    );
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Host {
  readonly paths: RedskilledPaths;
  readonly config: RedskilledClientConfig;
  readonly launchLog: string;
  readonly publishedBundle: string;
  readonly callerEntry: string;
  readonly root: string;
}

/** A session whose published bundle sits beside a foreign caller's, as a release ships them. */
async function host(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-unit-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  const launchLog = join(root, "launches.jsonl");
  const publishedBundle = join(dist, REDSKILLED_BUNDLE_ASSET);
  const callerEntry = join(dist, "dev.bundle.min.mjs");

  await writeFile(publishedBundle, publishedBundleSource(launchLog), { mode: 0o755 });
  await writeFile(callerEntry, "", { mode: 0o755 });

  const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}` }, runtimeDir: root });
  return {
    paths,
    launchLog,
    publishedBundle,
    callerEntry,
    root,
    config: {
      entryLookup: { callerEntry, execArgv: [], env: {}, listDir: () => [] },
      readyTimeoutMs: 30_000,
      idleMs: 60_000,
      env: { ...process.env, REDSKILLED_SESSION: `test:${root}` },
    },
  };
}

/** The fake published bundle: record this launch, then serve the real daemon. */
function publishedBundleSource(launchLog: string): string {
  return `import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ version: ${JSON.stringify(PUBLISHED_VERSION)}, entry: process.argv[1], pid: process.pid }) + "\\n");
const child = spawn(process.execPath, ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(cliEntry)}, ...process.argv.slice(2), "--daemon-version", ${JSON.stringify(PUBLISHED_VERSION)}], { stdio: "ignore" });
child.on("exit", (code) => process.exit(code ?? 0));
`;
}

function launches(path: string): Array<{ version: string; entry: string; pid: number }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { version: string; entry: string; pid: number });
}

/** Records every `systemctl` argv instead of running one — no systemd required. */
function recordingRun(results: Record<string, RedskilledUnitRunResult> = {}) {
  const calls: string[][] = [];
  const run = (argv: readonly string[]): RedskilledUnitRunResult => {
    calls.push([...argv]);
    return results[argv.join(" ")] ?? { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

/** The daemon's own pid, straight from the socket — the identity a revival changes. */
async function daemonPid(socketPath: string): Promise<number> {
  const response = await sendRedskilledRequest({ socketPath, timeoutMs: 2_000 }, { id: "ping", op: "ping" });
  if (!response.ok) throw new Error(response.error);
  return (response.value as { pid: number }).pid;
}

async function until(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the user unit that supervises the daemon", () => {
  it("starts the published bundle on this session's paths, and nothing else", async () => {
    const { paths, config, publishedBundle, callerEntry } = await host();

    const plan = planRedskilledUnit(paths, {
      env: { HOME: paths.runtimeDir },
      ...(config.entryLookup == null ? {} : { entryLookup: config.entryLookup }),
      idleMs: 60_000,
    });

    // The ExecStart is the published bundle serving THIS session — the same argv
    // a client spawn builds, from the same builder.
    expect(plan.args).toContain(publishedBundle);
    expect(plan.args).not.toContain(callerEntry);
    expect(plan.text).toContain(`ExecStart=${plan.command}`);
    for (const flag of ["--socket", paths.socketPath, "--lease", paths.leasePath, "--events", paths.eventLanePath]) {
      expect(plan.text).toContain(flag);
    }
    // The whole reason the unit exists.
    expect(plan.text).toContain("Restart=on-failure");
    expect(plan.text).toContain(`Environment="${REDSKILLED_SUPERVISED_ENV}=1"`);
    expect(plan.text).toContain(`Environment="REDSKILLED_SESSION=${paths.sessionKey}"`);
    expect(plan.text).toContain("WantedBy=default.target");
    expect(plan.unitPath).toBe(redskilledUnitPath({ HOME: paths.runtimeDir }));

    // A self-replacement leaves NON-ZERO precisely so `Restart=on-failure` catches
    // it: a clean exit would leave the machine on the old bundle with no daemon.
    expect(REDSKILLED_REPLACE_EXIT_CODE).not.toBe(0);
  });

  it("refuses to render a unit whose ExecStart would name nothing", async () => {
    const { paths, publishedBundle } = await host();
    await rm(publishedBundle, { force: true });

    expect(() =>
      planRedskilledUnit(paths, {
        env: { HOME: paths.runtimeDir },
        entryLookup: { callerEntry: join(paths.runtimeDir, "dist", "dev.bundle.min.mjs"), env: {}, listDir: () => [] },
      }),
    ).toThrow(RedskilledDaemonEntryError);
  });

  it("installs by writing the unit and enabling it NOW, and uninstalls by reversing that", async () => {
    const { paths, config } = await host();
    const unitEnv = { HOME: paths.runtimeDir };
    const plan = planRedskilledUnit(paths, {
      env: unitEnv,
      ...(config.entryLookup == null ? {} : { entryLookup: config.entryLookup }),
    });
    const install = recordingRun();

    const installed = await installRedskilledUnit(plan, { run: install.run });

    expect(installed.installed).toBe(true);
    expect(readFileSync(plan.unitPath, "utf8")).toBe(plan.text);
    expect(install.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      // `--now`: an install that only registered the unit would leave the machine
      // unsupervised until the next login.
      ["systemctl", "--user", "enable", "--now", REDSKILLED_UNIT_NAME],
    ]);

    const uninstall = recordingRun();
    const removed = await uninstallRedskilledUnit({ run: uninstall.run, env: unitEnv });

    expect(existsSync(plan.unitPath)).toBe(false);
    expect(uninstall.calls[0]).toEqual(["systemctl", "--user", "disable", "--now", REDSKILLED_UNIT_NAME]);
    expect(removed.steps.map((step) => step.step)).toEqual(["disable", "remove-unit", "daemon-reload"]);
  });

  it("revives a killed daemon with no client asking for work", async () => {
    const { paths, config, launchLog } = await host();
    const plan = planRedskilledUnit(paths, {
      env: { HOME: paths.runtimeDir },
      ...(config.entryLookup == null ? {} : { entryLookup: config.entryLookup }),
      idleMs: 60_000,
    });
    started.push(paths.socketPath);

    // The stand-in supervisor: run the unit's own ExecStart, exactly as systemd
    // would. Nothing here is a client, and nothing here asks for work.
    const startUnit = () => {
      const child = spawn(plan.command, [...plan.args], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [REDSKILLED_SUPERVISED_ENV]: "1", REDSKILLED_SESSION: paths.sessionKey },
      });
      children.push(child);
      child.unref();
    };

    startUnit();
    expect(await until(() => socketAnswers(paths.socketPath))).toBe(true);
    const first = await daemonPid(paths.socketPath);

    // The death the supervisor exists for: a hard kill, leaving the lease and the
    // socket file behind exactly as a crash does.
    process.kill(first, "SIGKILL");
    expect(await until(async () => !(await socketAnswers(paths.socketPath)))).toBe(true);

    // `Restart=on-failure` fires. No client has reached the socket in between.
    startUnit();
    expect(await until(() => socketAnswers(paths.socketPath))).toBe(true);

    const second = await daemonPid(paths.socketPath);
    expect(second).not.toBe(first);
    // Both daemons came from the published bundle, and only the supervisor started
    // either of them.
    expect(launches(launchLog)).toHaveLength(2);
    expect(launches(launchLog).every((launch) => launch.version === PUBLISHED_VERSION)).toBe(true);
  }, 90_000);
});

describe("a host with no unit installed", () => {
  it("reports the absent unit as a supported configuration, naming auto-spawn as the floor", async () => {
    const { paths } = await host();
    const probe = recordingRun();

    const status = readRedskilledUnitStatus({ env: { HOME: paths.runtimeDir }, run: probe.run });

    expect(status.installed).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.active).toBe(false);
    expect(status.floor).toBe("auto-spawn");
    // `is-enabled` on a unit that does not exist fails, and reporting that failure
    // as "not enabled" would give two different machines the same answer.
    expect(probe.calls).toEqual([]);
  });

  it("still gets a daemon, through auto-spawn", async () => {
    const { paths, config, launchLog } = await host();
    expect(existsSync(redskilledUnitPath({ HOME: paths.runtimeDir }))).toBe(false);

    const outcome = await ensureRedskilledDaemon(paths, config);
    started.push(paths.socketPath);

    expect(outcome).toBe("spawned");
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(launches(launchLog)).toHaveLength(1);
  }, 60_000);
});
