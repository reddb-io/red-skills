// The daemon is always on, and only `provision` ever starts one (ADR 0150 §4).
//
// Two facts, and they are opposite halves of the same rule:
//
//   1. a CLIENT that finds no daemon fails closed — non-zero exit, the canonical
//      repair invocation from the one namer, and NO child process spawned. Client
//      auto-spawn was ADR 0143's "resident by accident": whichever bundle the
//      client happened to carry decided which daemon the machine ran.
//   2. the PROVISIONER still has a route up, and it runs the PUBLISHED BUNDLE —
//      never the calling process's own entry path, the defect already fixed twice
//      (#2736 rsp, #2677 the launcher) — or names why it could not.
//
// The published bundle is faked, not built: the fixture is a real file at the real
// artifact name that records every launch and then serves, which is what lets the
// launch log answer "how many daemons?" and "from which file, at which version?".
// An empty launch log is what proves nothing was spawned at all.
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRedskilledDaemon,
  readRedskilledHostState,
  RedskilledDaemonEntryError,
  RedskilledNotProvisionedError,
  RedskilledUnreachableError,
  REDSKILLED_BUNDLE_ASSET,
  resolveRedskilledEntry,
  type RedskilledClientConfig,
} from "../src/client.js";
import { birthRedskilledDaemon } from "../src/daemon-birth.js";
import { REDSKILLED_PROVISION_FIX } from "../src/provision-fix.js";
import { socketAnswers } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import { assertIsolatedHostIdentity } from "./support/test-host-isolation.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

/** The version baked into the fake published bundle — deliberately not the caller's. */
const PUBLISHED_VERSION = "9.9.9-published";
/** The version the calling process claims, so a skew is visible if the caller ran. */
const CALLER_VERSION = "1.0.0-caller";

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
  /** Where the fake published bundle appends one line per launch. */
  readonly launchLog: string;
  /** Where the caller's own entry would append, if a spawn ever executed it. */
  readonly callerLog: string;
  readonly publishedBundle: string;
  readonly callerEntry: string;
  readonly root: string;
}

/**
 * A session whose "published bundle" exists on disk beside a foreign caller.
 *
 * `dist/` holds both artifacts a release ships side by side: the daemon's bundle
 * under its real name, and another app's bundle standing in for the caller. Only
 * the former may ever be executed.
 */
async function host(options: { readonly publishBundle?: boolean } = {}): Promise<Host> {
  // Every path below is invented under the suite's own root, and the identity
  // that resolves them is the sandbox's. Asserted rather than assumed: this
  // suite launches real processes, and one that inherited the operator's real
  // HOME would provision the developer's actual machine.
  assertIsolatedHostIdentity();
  const root = await mkdtemp(join(tmpdir(), "redskilled-birth-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  const launchLog = join(root, "launches.jsonl");
  const callerLog = join(root, "caller-launches.jsonl");
  const publishedBundle = join(dist, REDSKILLED_BUNDLE_ASSET);
  const callerEntry = join(dist, "dev.bundle.min.mjs");

  if (options.publishBundle !== false) await writeFile(publishedBundle, publishedBundleSource(launchLog), { mode: 0o755 });
  // The caller exists and is executable, so "the spawn did not run it" is a real
  // observation rather than an accident of a missing file.
  await writeFile(callerEntry, recordingSource(callerLog, CALLER_VERSION), { mode: 0o755 });

  const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
  return {
    paths,
    root,
    launchLog,
    callerLog,
    publishedBundle,
    callerEntry,
    config: {
      // Poses as a stale foreign host: a different app's bundle, at another version.
      entryLookup: { callerEntry, execArgv: [], env: {}, listDir: () => [] },
      readyTimeoutMs: 30_000,
      env: { ...process.env, REDSKILLED_SESSION: `test:${root}` },
    },
  };
}

/**
 * The fake published bundle: record this launch, then serve.
 *
 * It re-execs the real CLI through tsx so the daemon under test is the real one,
 * and states `--daemon-version` from the version baked HERE — which is how the
 * host state proves whose code answered, rather than whose code asked.
 */
function publishedBundleSource(launchLog: string): string {
  return `import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ version: ${JSON.stringify(PUBLISHED_VERSION)}, entry: process.argv[1], pid: process.pid }) + "\\n");
const child = spawn(process.execPath, ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(cliEntry)}, ...process.argv.slice(2), "--daemon-version", ${JSON.stringify(PUBLISHED_VERSION)}], { stdio: "ignore" });
child.on("exit", (code) => process.exit(code ?? 0));
`;
}

/** A file that records being run and nothing else — the caller's stand-in. */
function recordingSource(log: string, version: string): string {
  return `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ version: ${JSON.stringify(version)}, argv: process.argv.slice(1) }) + "\\n");
`;
}

/** One record per daemon launch. Absent file means nothing was ever launched. */
function launches(path: string): Array<{ version: string; entry: string; pid: number }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { version: string; entry: string; pid: number });
}

describe("a client that finds no daemon fails closed", () => {
  it("refuses in process, naming the one repair, without spawning anything", async () => {
    const { paths, config, launchLog, callerLog } = await host();
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const error = await ensureRedskilledDaemon(paths, config).then(
      (outcome) => outcome as never,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(RedskilledNotProvisionedError);
    // The one namer, verbatim: a second spelling of the repair is a second
    // repair, and the whole point of `REDSKILLED_PROVISION_FIX` is that there
    // is exactly one sentence to keep true.
    expect((error as Error).message).toContain(REDSKILLED_PROVISION_FIX);
    expect((error as Error).message).toContain("a client never starts one");

    // Nothing was born: not the published bundle, not the caller's own file.
    expect(launches(launchLog)).toEqual([]);
    expect(launches(callerLog)).toEqual([]);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  }, 60_000);

  it("exits non-zero from the shipped cli, printing the canonical invocation", async () => {
    const { paths, root, launchLog, callerLog } = await host();
    assertIsolatedHostIdentity();

    // A real client command, in a real child, against a session with no daemon.
    const run = spawnSync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "status"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          REDSKILLED_SESSION: `test:${root}`,
          REDSKILLED_MACHINE_DIR: root,
          XDG_RUNTIME_DIR: root,
        },
      },
    );

    expect(run.status, "a client with no daemon reported success").not.toBe(0);
    const said = `${run.stdout}${run.stderr}`;
    // ADR 0091's direct-run form, because a host with no daemon has no reason to
    // carry a PATH shim for one — a hint that names its own precondition is the
    // #2961 dead end.
    expect(said).toContain("npx -y -p @reddb-io/red-skills");
    expect(said).toContain("red-skills-redskilled provision");

    // And it spawned nothing on its way out.
    expect(launches(launchLog)).toEqual([]);
    expect(launches(callerLog)).toEqual([]);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  }, 60_000);
});

describe("provisioning is the one route from no daemon to a live one", () => {
  it("starts exactly one daemon, and a second call finds it rather than starting another", async () => {
    const { paths, config, launchLog } = await host();
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    expect(await birthRedskilledDaemon(paths, config)).toBe("spawned");
    started.push(paths.socketPath);

    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(launches(launchLog)).toHaveLength(1);

    const owner = (await readRedskilledHostState(paths, config)).pid;
    expect(owner).not.toBe(process.pid);
    for (const _ of [0, 1, 2]) {
      expect(await birthRedskilledDaemon(paths, config)).toBe("already-running");
      expect(await ensureRedskilledDaemon(paths, config)).toBe("already-running");
    }
    expect(launches(launchLog)).toHaveLength(1);
    expect((await readRedskilledHostState(paths, config)).pid).toBe(owner);
  }, 60_000);

  it("runs the published bundle, not the calling process's own entry path", async () => {
    const { paths, config, launchLog, callerLog, publishedBundle, callerEntry } = await host();

    // Resolution first: the caller's own file is reported, never chosen.
    const resolution = resolveRedskilledEntry({}, config.entryLookup);
    expect(resolution).toMatchObject({ entry: publishedBundle, source: "caller-sibling-bundle" });
    expect(resolution).not.toMatchObject({ entry: callerEntry });

    await birthRedskilledDaemon(paths, config);
    started.push(paths.socketPath);

    // Execution second: the file that ran is the published bundle, and the
    // daemon answers at the BUNDLE's version — a stale caller cannot mint a
    // staler daemon, which is the skew this rule exists to stop widening.
    expect(launches(launchLog)).toEqual([
      expect.objectContaining({ version: PUBLISHED_VERSION, entry: publishedBundle }),
    ]);
    expect(launches(callerLog), "the caller's own entry path was executed").toEqual([]);

    const state = await readRedskilledHostState(paths, config);
    expect(state.daemon_version).toBe(PUBLISHED_VERSION);
    expect(state.daemon_version).not.toBe(CALLER_VERSION);
  }, 60_000);

  it("fails loudly and names why when no published bundle can be resolved", async () => {
    const { paths, config, callerLog, publishedBundle, callerEntry } = await host({ publishBundle: false });
    expect(existsSync(publishedBundle)).toBe(false);

    const error = await birthRedskilledDaemon(paths, config).then(
      (outcome) => outcome as never,
      (err: unknown) => err,
    );
    // Named, and named at both ends: the diagnostic code plus the caller that
    // asked, because "which host asked?" is the operator's first question.
    expect(error).toBeInstanceOf(RedskilledDaemonEntryError);
    expect((error as RedskilledDaemonEntryError).code).toBe("redskilled-daemon-entry-unresolved");
    expect((error as RedskilledDaemonEntryError).searched).toContain(publishedBundle);
    expect((error as RedskilledDaemonEntryError).callerEntry).toBe(callerEntry);
    expect((error as Error).message).toContain("NOT used as a fallback");

    // The refusal is the whole behaviour: nothing was spawned at all, least of
    // all the caller's own file.
    expect(launches(callerLog)).toEqual([]);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  }, 60_000);

  it("surfaces a daemon that never bound as its own state, never as an empty answer", async () => {
    const { paths, config } = await host();
    // A command that exits without binding: the socket stays absent, so the
    // provisioner must report a start that failed and not a host with no Workers.
    const doomed: RedskilledClientConfig = {
      ...config,
      serverCommand: process.execPath,
      serverArgs: ["-e", "process.exit(3)"],
      readyTimeoutMs: 1_500,
    };

    const error = await birthRedskilledDaemon(paths, doomed).then(
      (outcome) => outcome as never,
      (err: unknown) => err,
    );
    expect((error as Error).message).toContain(paths.socketPath);
    // Nothing about the answer may look healthy: there is no state object to read.
    expect(error).not.toHaveProperty("workers");

    const reachError = await readRedskilledHostState(paths, doomed).then(
      (state) => state as never,
      (err: unknown) => err,
    );
    expect(reachError).toBeInstanceOf(RedskilledUnreachableError);
    expect((reachError as RedskilledUnreachableError).socketPath).toBe(paths.socketPath);
  }, 60_000);
});
