// The verbose statusline gives each Worker a second line carrying the last line
// it logged. The mechanism is the claim under test: the Worker PUBLISHES that
// line on its heartbeat as an opaque string, the daemon stores and returns it
// without ever interpreting it, and one read renders the whole global view — so
// no render ever opens another project's files. The one bounded exception is a
// restart, where the daemon rehydrates from the log path it was GIVEN at spawn.
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { runStatusline } from "../src/cli.js";
import {
  publishRedskilledWorkerLogLine,
  readRedskilledStatuslinePayload,
  readRedskilledStatuslineString,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { isRedskilledStatuslineRender } from "../src/protocol.js";
import {
  parseRedskilledStatuslineFlags,
  readRedskilledStatuslineConfig,
  resolveRedskilledStatuslineOptions,
} from "../src/statusline-config.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineOptions,
} from "../src/statusline-render.js";
import { buildStatuslinePayload, type RedskilledStatuslinePayload } from "../src/statusline-payload.js";
import type { RedskilledWorkerLogLine } from "../src/worker-log.js";

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
  const root = await scratch("redskilled-statusline-verbose-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    unit: "red-worker-acme-widgets-w-1.service",
    budget: { memory_max: "1G" },
    warnings: [],
    ...overrides,
  };
}

const MB = 1024 * 1024;

function payloadOf(
  workers: readonly RedskilledWorkerView[],
  rss: Record<string, number> = {},
  logLines: Record<string, RedskilledWorkerLogLine> = {},
): RedskilledStatuslinePayload {
  return buildStatuslinePayload({
    hostState: buildHostState({
      daemonVersion: "0.1.0",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-07-29T00:00:00.000Z",
      workers,
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss,
    logLines,
    sampledAt: "2026-07-29T01:00:00.000Z",
    now: "2026-07-29T01:00:05.000Z",
  });
}

function published(line: string): RedskilledWorkerLogLine {
  return { line, published_at: "2026-07-29T01:00:04.000Z", source: "heartbeat" };
}

function options(overrides: Partial<RedskilledStatuslineOptions> = {}): RedskilledStatuslineOptions {
  return { ...REDSKILLED_STATUSLINE_DEFAULTS, ...overrides };
}

describe("the verbose statusline", () => {
  it("gives each Worker a second line in the local mode", () => {
    const payload = payloadOf(
      [worker(), worker({ worker_id: "w-2", pid: 43, workspace_path: "/tmp/acme/w-2" })],
      { "w-1": 512 * MB, "w-2": 128 * MB },
      { "w-1": published("running the gate: 41 files"), "w-2": published("waiting on PR checks") },
    );

    const render = renderRedskilledStatusline(payload, options({ project: "acme/widgets", verbose: true }));

    expect(render.verbose).toBe(true);
    expect(render.lines).toHaveLength(3);
    expect(render.lines[0]).toBe(render.line);
    expect(render.lines[1]).toContain("w-1");
    expect(render.lines[1]).toContain("running the gate: 41 files");
    expect(render.lines[2]).toContain("waiting on PR checks");
  });

  it("gives each Worker a second line in the global mode, still naming its owner", () => {
    const payload = payloadOf(
      [worker(), worker({ worker_id: "w-2", project_label: "acme/gadgets", pid: 43 })],
      { "w-1": 512 * MB, "w-2": 128 * MB },
      { "w-1": published("gate green"), "w-2": published("rebasing onto main") },
    );

    const render = renderRedskilledStatusline(
      payload,
      options({ mode: "global", project: "acme/widgets", verbose: true }),
    );

    expect(render.detail).toBe("workers");
    expect(render.lines).toHaveLength(3);
    expect(render.lines[1]).toContain("acme/widgets:w-1");
    expect(render.lines[1]).toContain("gate green");
    expect(render.lines[2]).toContain("acme/gadgets:w-2");
    expect(render.lines[2]).toContain("rebasing onto main");
  });

  it("renders no empty or broken second line for a Worker that has logged nothing", () => {
    const payload = payloadOf(
      [worker(), worker({ worker_id: "w-2", pid: 43 })],
      { "w-1": 512 * MB, "w-2": 128 * MB },
      // `w-2` published nothing; `w-1` published only whitespace, which is the
      // same absence wearing a different disguise.
      { "w-1": published("   ") },
    );

    const render = renderRedskilledStatusline(payload, options({ project: "acme/widgets", verbose: true }));

    expect(render.lines).toHaveLength(1);
    expect(render.lines[0]).toBe(render.line);
    for (const line of render.lines) expect(line.trim()).not.toBe("");
  });

  it("keeps a published newline out of the line contract and honours the width", () => {
    const payload = payloadOf(
      [worker()],
      { "w-1": 512 * MB },
      { "w-1": published("first\nsecond\tthird   fourth fifth sixth seventh eighth") },
    );

    const render = renderRedskilledStatusline(
      payload,
      // Wide enough for the Worker entry, far too narrow for the published line:
      // the second line answers to the same clamp as the first.
      options({ project: "acme/widgets", verbose: true, maxWidth: 34 }),
    );

    expect(render.lines).toHaveLength(2);
    for (const line of render.lines) {
      expect(line).not.toContain("\n");
      expect([...line].length).toBeLessThanOrEqual(34);
    }
    // Collapsed, not re-interpreted: the words survive in the order published.
    expect(render.lines[1]).toContain("first second");
    expect(render.lines[1].endsWith("…")).toBe(true);
  });

  it("annotates nothing once the line has degraded past the Workers", () => {
    const workers = Array.from({ length: 6 }, (_, index) =>
      worker({ worker_id: `w-${index}`, project_label: `acme/project-${index}`, pid: 5000 + index }));
    const payload = payloadOf(
      workers,
      Object.fromEntries(workers.map((w) => [w.worker_id, 256 * MB])),
      Object.fromEntries(workers.map((w) => [w.worker_id, published(`working on ${w.worker_id}`)])),
    );

    const render = renderRedskilledStatusline(
      payload,
      options({ mode: "global", verbose: true, maxWorkers: 3, maxProjects: 6, maxWidth: 400 }),
    );

    // A second line belongs to a Worker entry; with no Worker entries on the
    // line there is nothing for one to be the second line OF.
    expect(render.detail).toBe("projects");
    expect(render.lines).toHaveLength(1);
  });
});

describe("the line the Worker publishes", () => {
  it("arrives through the heartbeat and comes back byte-identical", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: { "w-1": 512 * MB }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    // Content the daemon must not read for meaning: another surface's syntax, a
    // key/value pair, a level marker. It stores a string and returns a string.
    const opaque = 'host 9w/9p [error] {"detail":"nope"} · stale 60s';
    const ack = await publishRedskilledWorkerLogLine(
      paths,
      { worker_id: "w-1", line: opaque },
      { sessionProject: "acme/widgets" },
    );
    expect(ack.accepted).toBe(true);

    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    expect(payload.workers[0]?.log.last_line).toBe(opaque);
    expect(payload.workers[0]?.log.source).toBe("heartbeat");

    const asked = options({ project: "acme/widgets", verbose: true, maxWidth: 400 });
    const render = await readRedskilledStatuslineString(paths, asked, { sessionProject: "acme/widgets" });
    expect(isRedskilledStatuslineRender(render)).toBe(true);
    expect(render.lines).toEqual(renderRedskilledStatusline(payload, asked).lines);
    expect(render.lines[1]).toContain(opaque);
  });

  it("is refused from a session in another project, and never stored", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: {}, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());

    await expect(
      publishRedskilledWorkerLogLine(paths, { worker_id: "w-1", line: "not mine to say" }, {
        sessionProject: "acme/gadgets",
      }),
    ).rejects.toThrow(/refused/);

    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    expect(payload.workers[0]?.log.last_line).toBeNull();
  });

  it("renders the whole global view from that one read, opening no project's files", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: { "w-1": 512 * MB, "w-2": 128 * MB }, cpu_seconds: {} }),
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    daemon.trackWorker(worker({ worker_id: "w-2", project_label: "acme/gadgets", pid: 43 }));
    for (const [id, project] of [["w-1", "acme/widgets"], ["w-2", "acme/gadgets"]] as const) {
      await publishRedskilledWorkerLogLine(paths, { worker_id: id, line: `busy in ${project}` }, {
        sessionProject: project,
      });
    }

    const cwd = await scratch("redskilled-verbose-project-");
    await mkdir(join(cwd, ".red"), { recursive: true });
    await writeFile(
      join(cwd, ".red", "config.yaml"),
      ["project:", "  name: acme/widgets", ""].join("\n"),
      "utf8",
    );

    const written: string[] = [];
    const code = await runStatusline(["global", "--verbose", "--max-width", "400"], {
      cwd,
      paths,
      write: (line) => written.push(line),
      warn: () => undefined,
    });

    // One write, one read: both projects' second lines are already in the single
    // payload the daemon served, so nothing has to go looking for a log.
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    const lines = written[0].trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("busy in acme/widgets");
    expect(lines[2]).toContain("busy in acme/gadgets");

    // The renderer could not open a foreign project's log even if it wanted to:
    // it is a pure function of the payload and reaches no filesystem at all.
    const source = readFileSync(join(import.meta.dirname, "..", "src", "statusline-render.ts"), "utf8");
    expect(source).not.toMatch(/from "node:fs/);
  });
});

describe("a restart with no information", () => {
  it("rehydrates from the log path it was given, and never from a derived layout", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-verbose-workspace-");
    const given = join(workspace, "given.log");
    await writeFile(given, "earlier line\nthe last line it logged\n", "utf8");
    // A file a layout-guessing daemon would find inside the workspace. Reading it
    // would be the private source the single-anchor rule forbids.
    await writeFile(join(workspace, "worker.log"), "a layout the daemon must not assume\n", "utf8");

    const first = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: {}, cpu_seconds: {} }),
    });
    first.trackWorker(worker({ workspace_path: workspace, log_path: given }));
    first.trackWorker(worker({ worker_id: "w-2", pid: 43, workspace_path: workspace }));
    await first.flushEvents();
    await first.stop();

    const second = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => "2026-07-29T01:05:00.000Z",
      treeSampler: () => ({ rss: {}, cpu_seconds: {} }),
      // The host still confirms both Workers, so the daemon holds two Workers it
      // has never heard a heartbeat from — the one state that permits a read.
      liveness: () => true,
    });
    running.push(second);

    const payload = second.statuslinePayload();
    const rehydrated = payload.workers.find((w) => w.worker_id === "w-1");
    const unknown = payload.workers.find((w) => w.worker_id === "w-2");

    expect(rehydrated?.log.last_line).toBe("the last line it logged");
    expect(rehydrated?.log.source).toBe("rehydrated");
    // No log path was given for `w-2`, so there is no path to read — a daemon
    // that guessed `workspace/worker.log` would have found one.
    expect(unknown?.log.last_line).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("a layout the daemon must not assume");
  });
});

describe("the verbose taste", () => {
  it("is declarable in config and overridable by a flag", () => {
    const config = ["plugins:", "  dev:", "    statusline:", "      verbose: true"].join("\n");
    expect(readRedskilledStatuslineConfig(config).config.verbose).toBe(true);
    expect(resolveRedskilledStatuslineOptions({ configText: config }).options.verbose).toBe(true);

    const { flags } = parseRedskilledStatuslineFlags(["--no-verbose"]);
    expect(resolveRedskilledStatuslineOptions({ configText: config, flags }).options.verbose).toBe(false);
    expect(parseRedskilledStatuslineFlags(["--verbose"]).flags.verbose).toBe(true);
    expect(REDSKILLED_STATUSLINE_DEFAULTS.verbose).toBe(false);
  });

  it("ignores and names a malformed declaration instead of refusing to render", () => {
    const broken = ["plugins:", "  dev:", "    statusline:", "      verbose: loud"].join("\n");
    const resolved = resolveRedskilledStatuslineOptions({ configText: broken });

    expect(resolved.options.verbose).toBe(false);
    expect(resolved.warnings.map((w) => w.reason)).toEqual(["expected `true` or `false`"]);
  });
});
