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
//   2. `Restart=always` is declared, and the install actually enables it NOW;
//   3. a cleanly self-stopped daemon driven only by that ExecStart comes BACK, with no client
//      asking for work in between;
//   4. a host with no unit still gets a daemon, and says so rather than reading
//      as broken.
//
// The supervisor is stood in for rather than assumed: the test runs the unit's own
// ExecStart when the process exits, which is exactly what `Restart=always`
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
  RedskilledNotProvisionedError,
  REDSKILLED_BUNDLE_ASSET,
  type RedskilledClientConfig,
} from "../src/client.js";
import { birthRedskilledDaemon } from "../src/daemon-birth.js";
import { socketAnswers, startRedskilledDaemon } from "../src/daemon.js";
import { RedskilledDaemonEntryError } from "../src/daemon-entry.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import { REDSKILLED_REPLACE_EXIT_CODE } from "../src/self-replace.js";
import {
  healRedskilledUnitDropIn,
  installRedskilledUnit,
  planRedskilledUnit,
  readRedskilledUnitStatus,
  redskilledReplacementDropInPath,
  redskilledUnitPath,
  repointRedskilledUnitForReplacement,
  REDSKILLED_SUPERVISED_ENV,
  REDSKILLED_UNIT_NAME,
  uninstallRedskilledUnit,
  type RedskilledUnitRunResult,
} from "../src/supervision.js";
import { redskilledStableBundleDir, redskilledStableBundleName } from "../src/stable-bundle.js";

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

  const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
  return {
    paths,
    launchLog,
    publishedBundle,
    callerEntry,
    root,
    config: {
      entryLookup: { callerEntry, execArgv: [], env: {}, listDir: () => [] },
      readyTimeoutMs: 30_000,
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
    expect(plan.text).toContain("Restart=always");
    expect(plan.text).toContain("LimitCORE=0");
    // The daemon's own budget: a multi-day leak takes THIS unit down (and
    // Restart= brings back a fresh generation) before it takes the machine.
    expect(plan.text).toContain("MemoryHigh=1G");
    expect(plan.text).toContain("MemoryMax=2G");
    expect(plan.text).toContain("StartLimitIntervalSec=60");
    expect(plan.text).toContain("StartLimitBurst=5");
    expect(plan.text).toContain(`Environment="${REDSKILLED_SUPERVISED_ENV}=1"`);
    expect(plan.text).toContain(`Environment="REDSKILLED_SESSION=${paths.sessionKey}"`);
    expect(plan.text).toContain("WantedBy=default.target");
    expect(plan.unitPath).toBe(redskilledUnitPath({ HOME: paths.runtimeDir }));

    // Self-replacement still uses a distinct exit code for observability, even
    // though the unit now restarts every daemon exit.
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
    const oldReplacement = redskilledReplacementDropInPath(unitEnv);
    await mkdir(resolve(oldReplacement, ".."), { recursive: true });
    await writeFile(oldReplacement, "[Service]\nExecStart=/obsolete-entry\n");
    const install = recordingRun();

    const installed = await installRedskilledUnit(plan, { run: install.run });

    expect(installed.installed).toBe(true);
    expect(readFileSync(plan.unitPath, "utf8")).toBe(plan.text);
    expect(existsSync(oldReplacement)).toBe(false);
    expect(install.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      // `--now`: an install that only registered the unit would leave the machine
      // unsupervised until the next login.
      ["systemctl", "--user", "enable", "--now", REDSKILLED_UNIT_NAME],
    ]);

    await writeFile(oldReplacement, "[Service]\nExecStart=/obsolete-entry\n");
    const uninstall = recordingRun();
    const removed = await uninstallRedskilledUnit({ run: uninstall.run, env: unitEnv });

    expect(existsSync(plan.unitPath)).toBe(false);
    expect(existsSync(oldReplacement)).toBe(false);
    expect(uninstall.calls[0]).toEqual(["systemctl", "--user", "disable", "--now", REDSKILLED_UNIT_NAME]);
    expect(removed.steps.map((step) => step.step)).toEqual(["disable", "remove-unit", "daemon-reload"]);
  });

  it("atomically repoints the supervised restart to the resolved successor", async () => {
    const { paths, publishedBundle } = await host();
    const env = { HOME: paths.runtimeDir };
    const reload = recordingRun();

    const path = repointRedskilledUnitForReplacement(
      { command: process.execPath, args: [publishedBundle] },
      paths,
      { env, run: reload.run },
    );

    expect(path).toBe(redskilledReplacementDropInPath(env));
    const dropIn = readFileSync(path, "utf8");
    expect(dropIn).toContain("ExecStart=\n");
    expect(dropIn).toContain(publishedBundle);
    expect(dropIn).toContain(paths.socketPath);
    expect(reload.calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });

  it("refuses to repoint the unit to a relative command before writing anything — 203/EXEC is never installed", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const reload = recordingRun();

    // systemd resolves ExecStart with the MANAGER's PATH, so a bare `npx` is
    // unresolvable on hosts whose node comes from a version manager (#3554).
    expect(() =>
      repointRedskilledUnitForReplacement(
        { command: "npx", args: ["-y", "-p", "@reddb-io/red-skills@9.9.9", "red-skills-redskilled"] },
        paths,
        { env, run: reload.run },
      ),
    ).toThrow(/relative command "npx"/);

    // Nothing was written and systemd was never reloaded: the serving daemon
    // stays up on its current ExecStart, the upgrade merely waits.
    expect(existsSync(redskilledReplacementDropInPath(env))).toBe(false);
    expect(reload.calls).toEqual([]);
  });

  it("heals a drop-in poisoned with a relative command into this process's own absolute invocation", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(
      dropIn,
      `[Service]\nExecStart=\nExecStart=npx -y -p @reddb-io/red-skills@9.9.9 red-skills-redskilled serve --socket ${paths.socketPath}\n`,
    );
    const reload = recordingRun();

    const report = healRedskilledUnitDropIn({
      env,
      socketPath: paths.socketPath,
      execPath: "/fake/toolchain/node-lts/bin/node",
      argv: ["/fake/bundle/redskilled.bundle.min.mjs", "serve", "--socket", paths.socketPath],
      run: reload.run,
    });

    expect(report).toEqual({ path: dropIn, status: "healed", command: "npx" });
    const healed = readFileSync(dropIn, "utf8");
    expect(healed).toContain("ExecStart=\n");
    expect(healed).toContain(
      `ExecStart=/fake/toolchain/node-lts/bin/node /fake/bundle/redskilled.bundle.min.mjs serve --socket ${paths.socketPath}`,
    );
    expect(reload.calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });

  it("never rewrites a drop-in that serves some other session's socket — a test or foreign process has no claim", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);
    const poisoned =
      "[Service]\nExecStart=\nExecStart=npx -y -p @reddb-io/red-skills@9.9.9 red-skills-redskilled serve --socket /run/someone-else.sock\n";
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, poisoned);
    const reload = recordingRun();

    const report = healRedskilledUnitDropIn({ env, socketPath: paths.socketPath, run: reload.run });

    expect(report).toEqual({ path: dropIn, status: "foreign", command: "npx" });
    expect(readFileSync(dropIn, "utf8")).toBe(poisoned);
    expect(reload.calls).toEqual([]);
  });

  it("leaves an absolute drop-in byte-for-byte untouched, and reports an absent one without inventing it", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);

    expect(healRedskilledUnitDropIn({ env, run: recordingRun().run })).toEqual({
      path: dropIn,
      status: "absent",
    });

    const absolute = "[Service]\nExecStart=\nExecStart=/usr/bin/node /opt/redskilled.bundle.min.mjs serve\n";
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, absolute);
    const reload = recordingRun();

    const report = healRedskilledUnitDropIn({ env, run: reload.run });

    expect(report).toEqual({ path: dropIn, status: "absolute", command: "/usr/bin/node" });
    expect(readFileSync(dropIn, "utf8")).toBe(absolute);
    expect(reload.calls).toEqual([]);
  });

  it("revives a cleanly self-stopped daemon with no client asking for work", async () => {
    const { paths, config, launchLog } = await host();
    const plan = planRedskilledUnit(paths, {
      env: { HOME: paths.runtimeDir },
      ...(config.entryLookup == null ? {} : { entryLookup: config.entryLookup }),
    });
    started.push(paths.socketPath);

    // The stand-in supervisor: run the unit's own ExecStart, exactly as systemd
    // would. Nothing here is a client, and nothing here asks for work.
    const startUnit = (): ChildProcess => {
      const child = spawn(plan.command, [...plan.args], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [REDSKILLED_SUPERVISED_ENV]: "1", REDSKILLED_SESSION: paths.sessionKey },
      });
      children.push(child);
      child.unref();
      return child;
    };

    const firstUnitProcess = startUnit();
    expect(await until(() => socketAnswers(paths.socketPath))).toBe(true);
    const first = await daemonPid(paths.socketPath);

    // The regression: the daemon may decide to stop itself and exit zero. Under
    // an on-failure policy this leaves an enabled unit inactive indefinitely.
    const firstExit = new Promise<number | null>((resolveExit) => firstUnitProcess.once("exit", resolveExit));
    await sendRedskilledRequest({ socketPath: paths.socketPath }, { id: "self-shutdown", op: "shutdown" });
    expect(await until(async () => !(await socketAnswers(paths.socketPath)))).toBe(true);
    expect(await firstExit).toBe(0);

    // `Restart=always` fires even for that clean exit. No client has reached the
    // socket in between.
    startUnit();
    expect(await until(() => socketAnswers(paths.socketPath))).toBe(true);

    const second = await daemonPid(paths.socketPath);
    expect(second).not.toBe(first);
    // Both daemons came from the published bundle, and only the supervisor started
    // either of them.
    expect(launches(launchLog)).toHaveLength(2);
    expect(launches(launchLog).every((launch) => launch.version === PUBLISHED_VERSION)).toBe(true);
  }, 90_000);

  it("routes a cold client through the installed supervisor instead of auto-spawning a rival", async () => {
    const { paths, config, launchLog, root } = await host();
    // The unit was installed from one environment, while this client resolved a
    // different runtime directory. There is no live claim until systemd starts
    // the unit, so the rendezvous has to be discovered during the wait.
    const clientPaths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: "other-runtime", REDSKILLED_MACHINE_DIR: root },
      runtimeDir: join(root, "other-runtime"),
      homeDir: root,
      machineClaimPath: paths.machineClaimPath,
    });
    let supervisorStarts = 0;
    const outcome = await ensureRedskilledDaemon(clientPaths, {
      ...config,
      readyTimeoutMs: 300,
      supervisor: {
        installed: () => true,
        start: async () => {
          supervisorStarts += 1;
          await startRedskilledDaemon({ paths });
        },
      },
    });
    started.push(paths.socketPath);

    expect(outcome).toBe("joined");
    expect(supervisorStarts).toBe(1);
    await expect(ensureRedskilledDaemon(clientPaths)).resolves.toBe("joined");
    // The launch log belongs to the client's published-bundle auto-spawn path.
    // Empty proves only the supervisor created the daemon.
    expect(launches(launchLog)).toEqual([]);
  });
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

  it("is provisioned directly, and its clients still fail closed until it is", async () => {
    const { paths, config, launchLog } = await host();
    expect(existsSync(redskilledUnitPath({ HOME: paths.runtimeDir }))).toBe(false);

    // Nothing on the machine, so a client says so rather than becoming the daemon.
    await expect(ensureRedskilledDaemon(paths, config)).rejects.toBeInstanceOf(RedskilledNotProvisionedError);
    expect(launches(launchLog)).toEqual([]);

    const outcome = await birthRedskilledDaemon(paths, config);
    started.push(paths.socketPath);

    expect(outcome).toBe("spawned");
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(launches(launchLog)).toHaveLength(1);
  }, 60_000);
});

describe("an installed user unit", () => {
  it("surfaces an enabled-but-dead unit as a finding", async () => {
    const { paths } = await host();
    await mkdir(resolve(redskilledUnitPath({ HOME: paths.runtimeDir }), ".."), { recursive: true });
    await writeFile(redskilledUnitPath({ HOME: paths.runtimeDir }), "[Service]\nRestart=always\n");
    const probe = recordingRun({
      [`systemctl --user is-enabled ${REDSKILLED_UNIT_NAME}`]: { status: 0 },
      [`systemctl --user is-active ${REDSKILLED_UNIT_NAME}`]: { status: 3 },
    });

    const status = readRedskilledUnitStatus({ env: { HOME: paths.runtimeDir }, run: probe.run });

    expect(status.installed).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.active).toBe(false);
    expect(status.findings).toEqual([
      expect.objectContaining({ code: "enabled-but-inactive" }),
    ]);
  });
});

describe("stabilizing a pinned npx drop-in", () => {
  it("rewrites a pinned npx ExecStart onto the stable copy of the running version", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(
      dropIn,
      `[Service]\nExecStart=\nExecStart=/usr/local/bin/npx -y -p @reddb-io/red-skills@4.2.9 red-skills-redskilled serve --socket ${paths.socketPath}\n`,
    );
    const stableDir = redskilledStableBundleDir(paths.runtimeDir);
    const stable = join(stableDir, redskilledStableBundleName("4.2.9"));
    await mkdir(stableDir, { recursive: true });
    await writeFile(stable, "the filed bytes");
    const reload = recordingRun();

    const report = healRedskilledUnitDropIn({
      env,
      socketPath: paths.socketPath,
      execPath: "/fake/toolchain/node-lts/bin/node",
      version: "4.2.9",
      run: reload.run,
    });

    expect(report).toEqual({ path: dropIn, status: "stabilized", command: "/usr/local/bin/npx" });
    expect(readFileSync(dropIn, "utf8")).toContain(
      `ExecStart=/fake/toolchain/node-lts/bin/node ${stable} serve --socket ${paths.socketPath}`,
    );
    expect(reload.calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
  });

  it("leaves a pinned npx ExecStart untouched when the stable copy is absent or the version differs", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);
    const pinned =
      `[Service]\nExecStart=\nExecStart=/usr/local/bin/npx -y -p @reddb-io/red-skills@4.2.9 red-skills-redskilled serve --socket ${paths.socketPath}\n`;
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, pinned);
    const reload = recordingRun();

    // No stable copy on disk: healthy but not rewritable.
    expect(healRedskilledUnitDropIn({ env, socketPath: paths.socketPath, version: "4.2.9", run: reload.run }))
      .toEqual({ path: dropIn, status: "absolute", command: "/usr/local/bin/npx" });
    // A different running version has no claim on this pin.
    const stableDir = redskilledStableBundleDir(paths.runtimeDir);
    await mkdir(stableDir, { recursive: true });
    await writeFile(join(stableDir, redskilledStableBundleName("4.3.0")), "newer bytes");
    expect(healRedskilledUnitDropIn({ env, socketPath: paths.socketPath, version: "4.3.0", run: reload.run }))
      .toEqual({ path: dropIn, status: "absolute", command: "/usr/local/bin/npx" });
    expect(readFileSync(dropIn, "utf8")).toBe(pinned);
    expect(reload.calls).toEqual([]);
  });

  it("a pinned npx drop-in serving another session's socket is foreign, never rewritten", async () => {
    const { paths } = await host();
    const env = { HOME: paths.runtimeDir };
    const dropIn = redskilledReplacementDropInPath(env);
    const pinned =
      "[Service]\nExecStart=\nExecStart=/usr/local/bin/npx -y -p @reddb-io/red-skills@4.2.9 red-skills-redskilled serve --socket /run/someone-else.sock\n";
    await mkdir(resolve(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, pinned);
    const reload = recordingRun();

    expect(healRedskilledUnitDropIn({ env, socketPath: paths.socketPath, version: "4.2.9", run: reload.run }))
      .toEqual({ path: dropIn, status: "foreign", command: "/usr/local/bin/npx" });
    expect(readFileSync(dropIn, "utf8")).toBe(pinned);
    expect(reload.calls).toEqual([]);
  });
});
