// The first client reaching an absent socket starts the daemon — ADR 0130 rule 7,
// one behaviour with an optional supervisor, never a second manual start mode.
//
// Nothing used to spawn the daemon at all, so every consumer of host-scoped truth
// silently got nothing (issue #2843). These checks pin the four facts that make
// auto-spawn trustworthy rather than merely present:
//
//   1. an absent socket produces EXACTLY ONE daemon, and a live socket produces none;
//   2. clients racing an absent socket converge on one daemon;
//   3. the spawn runs the PUBLISHED BUNDLE — never the calling process's own entry
//      path, the defect already fixed twice here (#2736 rsp, #2677 the launcher);
//   4. a daemon that cannot be resolved or reached is a NAMED state, never an
//      empty answer that reads as a healthy machine with nothing running.
//
// The published bundle is faked, not built: the fixture is a real file at the real
// artifact name that records every launch and then serves, which is what lets the
// launch log answer "how many daemons?" and "from which file, at which version?".
import type { ChildProcess } from "node:child_process";
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
  RedskilledUnreachableError,
  REDSKILLED_BUNDLE_ASSET,
  resolveRedskilledEntry,
  type RedskilledClientConfig,
} from "../src/client.js";
import { socketAnswers } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";

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
}

/**
 * A session whose "published bundle" exists on disk beside a foreign caller.
 *
 * `dist/` holds both artifacts a release ships side by side: the daemon's bundle
 * under its real name, and another app's bundle standing in for the caller. Only
 * the former may ever be executed.
 */
async function host(options: { readonly publishBundle?: boolean } = {}): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-spawn-"));
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

  const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}` }, runtimeDir: root });
  return {
    paths,
    launchLog,
    callerLog,
    publishedBundle,
    callerEntry,
    config: {
      // Poses as a stale foreign host: a different app's bundle, at another version.
      entryLookup: { callerEntry, execArgv: [], env: {}, listDir: () => [] },
      readyTimeoutMs: 30_000,
      idleMs: 60_000,
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

describe("redskilled auto-spawn at the client reach boundary", () => {
  it("starts exactly one daemon when a client reaches an absent socket", async () => {
    const { paths, config, launchLog } = await host();
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const outcome = await ensureRedskilledDaemon(paths, config);
    started.push(paths.socketPath);

    expect(outcome).toBe("spawned");
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(launches(launchLog)).toHaveLength(1);

    // The original request completes without the caller retrying anything.
    const state = await readRedskilledHostState(paths, config);
    expect(state.pid).not.toBe(process.pid);
  }, 60_000);

  it("resolves concurrent clients racing an absent socket into one daemon", async () => {
    const { paths, config, launchLog } = await host();

    const outcomes = await Promise.all([
      ensureRedskilledDaemon(paths, config),
      ensureRedskilledDaemon(paths, config),
      ensureRedskilledDaemon(paths, config),
    ]);
    started.push(paths.socketPath);

    // Every client ends up served, and only one of them did the spawning.
    expect(outcomes.filter((outcome) => outcome === "spawned")).toHaveLength(1);
    expect(launches(launchLog)).toHaveLength(1);

    const state = await readRedskilledHostState(paths, config);
    expect((await readRedskilledHostState(paths, config)).pid).toBe(state.pid);
  }, 60_000);

  it("runs the published bundle, not the calling process's own entry path", async () => {
    const { paths, config, launchLog, callerLog, publishedBundle, callerEntry } = await host();

    // Resolution first: the caller's own file is reported, never chosen.
    const resolution = resolveRedskilledEntry({}, config.entryLookup);
    expect(resolution).toMatchObject({ entry: publishedBundle, source: "caller-sibling-bundle" });
    expect(resolution).not.toMatchObject({ entry: callerEntry });

    await ensureRedskilledDaemon(paths, config);
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

  it("does not spawn a second daemon when a client reaches a live socket", async () => {
    const { paths, config, launchLog } = await host();
    const first = await ensureRedskilledDaemon(paths, config);
    started.push(paths.socketPath);
    expect(first).toBe("spawned");
    const owner = (await readRedskilledHostState(paths, config)).pid;

    for (const _ of [0, 1, 2]) {
      expect(await ensureRedskilledDaemon(paths, config)).toBe("already-running");
    }

    expect(launches(launchLog)).toHaveLength(1);
    expect((await readRedskilledHostState(paths, config)).pid).toBe(owner);
  }, 60_000);

  it("fails loudly and names why when no published bundle can be resolved", async () => {
    const { paths, config, callerLog, publishedBundle, callerEntry } = await host({ publishBundle: false });
    expect(existsSync(publishedBundle)).toBe(false);

    const error = await readRedskilledHostState(paths, config).then(
      (state) => state as never,
      (err: unknown) => err,
    );
    // Named, and named at both ends: the diagnostic code plus the caller that
    // asked, because "which host asked?" is the operator's first question.
    expect(error).toBeInstanceOf(RedskilledUnreachableError);
    const cause = (error as RedskilledUnreachableError).cause;
    expect(cause).toBeInstanceOf(RedskilledDaemonEntryError);
    expect((cause as RedskilledDaemonEntryError).code).toBe("redskilled-daemon-entry-unresolved");
    expect((cause as RedskilledDaemonEntryError).searched).toContain(publishedBundle);
    expect((cause as RedskilledDaemonEntryError).callerEntry).toBe(callerEntry);
    expect((error as Error).message).toContain("NOT used as a fallback");

    // The refusal is the whole behaviour: nothing was spawned at all, least of
    // all the caller's own file.
    expect(launches(callerLog)).toEqual([]);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  }, 60_000);

  it("surfaces an unreachable daemon as its own state, never as an empty answer", async () => {
    const { paths, config } = await host();
    // A command that exits without binding: the socket stays absent, so the
    // client must report "no host answered" and not a host with no Workers.
    const doomed: RedskilledClientConfig = {
      ...config,
      serverCommand: process.execPath,
      serverArgs: ["-e", "process.exit(3)"],
      readyTimeoutMs: 1_500,
    };

    const error = await readRedskilledHostState(paths, doomed).then(
      (state) => state as never,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RedskilledUnreachableError);
    expect((error as RedskilledUnreachableError).socketPath).toBe(paths.socketPath);
    expect((error as Error).message).toContain(paths.socketPath);
    // Nothing about the answer may look healthy: there is no state object to read.
    expect(error).not.toHaveProperty("workers");
  }, 60_000);
});
