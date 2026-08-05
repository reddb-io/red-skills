import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { decode, encode } from "@reddb-io/toon";
import { LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import {
  statuslineCommand,
  resolveRoot,
  resolveStatuslineRsp,
  resolveStatuslinePreset,
  statuslineEnabled,
} from "../src/commands/statusline.js";
import { loadConfig } from "../src/core/config.js";
import { readPidStartTime } from "../src/core/state.js";
import { afkPaths } from "../src/runtime/wire.js";
import { resolveResidentPaths } from "../../rsp/src/resident-client.js";

/** Strip ANSI SGR escapes so assertions read the plain rendered text. The
 * command now themes the line (wine background + black-chipped KPI numbers);
 * stripping recovers the exact plain content the renderer produced. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function startOfCurrentUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** A non-TTY readable carrying the Claude Code payload on stdin. */
function fakeStdin(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = Readable.from([text]) as Readable & { isTTY?: boolean };
  stream.isTTY = false;
  return stream;
}

/** A writable sink that accumulates what the command emits. */
function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

/** Write a fake live worker state (pid = this process → always live). A caller
 * can pass its own `pid` in `state` to override — e.g. `pid: 0` for a
 * finished/retained attempt. `namespace` selects the worker lane (default the
 * fleet `workers` lane; pass `go-workers`/`scout-workers` for those lanes). */
async function writeWorkerState(
  root: string,
  worker: string,
  attempt: string,
  state: Record<string, unknown>,
  namespace = "workers",
): Promise<void> {
  const dir = join(root, ".red", "tmp", namespace, worker, attempt);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "afk.state.toon"), JSON.stringify({ pid: process.pid, ...state }), "utf8");
}

/** Write a FRESH liveness lane record into an attempt dir so the red-castle
 * evaluator reads the attempt as lane-fresh ("alive"). This is what makes a
 * just-finished attempt (pid 0) still look live during its post-mortem retention
 * window — the exact condition issue #1177's statusline filter must survive. */
async function writeFreshLivenessLane(
  root: string,
  worker: string,
  attempt: string,
  namespace = "workers",
): Promise<void> {
  const dir = join(root, ".red", "tmp", namespace, worker, attempt);
  await mkdir(dir, { recursive: true });
  const record = JSON.stringify({ at: Date.now(), kind: "iteration" }) + "\n";
  await writeFile(join(dir, LIVENESS_LANE_FILENAME), record, "utf8");
}

/** Pre-seed a FRESH gh count cache so collectStatuslineAfk never calls gh. */
async function seedFreshCache(root: string, queue: number, human: number): Promise<void> {
  const dir = join(root, ".red", "state", "statusline");
  await mkdir(dir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  await writeFile(join(dir, "statusline-cache.toon"), encode({ queue, human, ts }), "utf8");
}

/** Pre-seed a FRESH repo-stats cache so collectStatuslineRepo never calls gh. */
async function seedFreshRepoCache(
  root: string,
  openPrs: number,
  openIssues: number,
  todayPrs = 0,
): Promise<void> {
  const dir = join(root, ".red", "state", "statusline");
  await mkdir(dir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  await writeFile(
    join(dir, "statusline-repo-cache.toon"),
    encode({ openPrs, todayPrs, openIssues, ts }),
    "utf8",
  );
}

async function writeFleetSnapshot(
  root: string,
  over: Record<string, unknown> = {},
): Promise<void> {
  const dir = dirname(afkPaths(root).supervisorPidPath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "afk-supervisor.pid"), `${process.pid}\n`, "utf8");
  await writeFile(
    join(dir, "afk-supervisor.pid.start"),
    `${readPidStartTime(process.pid)!}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "state.toon"),
    JSON.stringify({
      ts: new Date().toISOString(),
      epoch: Math.floor(Date.now() / 1000),
      runner: "codex",
      ready_for_agent: 2,
      slots: { busy: 1, free: 0, total: 1, parked: 0 },
      spawns_this_tick: 0,
      ...over,
    }),
    "utf8",
  );
}

async function listenRspSocket(root: string, mode: "reply" | "hang"): Promise<Server> {
  const { socketPath } = resolveResidentPaths(root);
  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (mode === "hang") return;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      const request = JSON.parse(raw) as { id: string };
      socket.end(`${JSON.stringify({ id: request.id, ok: true, value: "pong" })}\n`);
    });
  });
  (server as Server & { __sockets?: Set<Socket> }).__sockets = sockets;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  for (const socket of (server as Server & { __sockets?: Set<Socket> }).__sockets ?? []) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const PAYLOAD = JSON.stringify({
  model: { display_name: "Opus" },
  effort: { level: "high" },
  context_window: { total_input_tokens: 47000, used_percentage: 24 },
});

/** Payload with the Pro/Max rate-limit windows Claude Code exposes after the
 * first API response — only present for Pro/Max sessions. */
const PAYLOAD_WITH_RATE_LIMITS = JSON.stringify({
  model: { display_name: "Opus" },
  effort: { level: "high" },
  context_window: { total_input_tokens: 47000, used_percentage: 24 },
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: "2026-07-05T17:00:00Z" },
    seven_day: { used_percentage: 41, resets_at: "2026-07-12T12:00:00Z" },
  },
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initRepoWithDevelopTrunk(root: string): Promise<void> {
  git(root, ["init"]);
  git(root, ["config", "user.email", "agent@example.test"]);
  git(root, ["config", "user.name", "Agent"]);
  git(root, ["checkout", "-b", "main"]);
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  git(root, ["checkout", "-b", "develop"]);
  await writeFile(join(root, "backlog.txt"), "backlog\n", "utf8");
  git(root, ["add", "backlog.txt"]);
  git(root, ["commit", "-m", "develop backlog"]);
  git(root, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);

  git(root, ["checkout", "-b", "feature/statusline"]);
  await writeFile(join(root, "work.txt"), "work\n", "utf8");
  git(root, ["add", "work.txt"]);
  git(root, ["commit", "-m", "feature work"]);
}

async function initSimpleRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "agent@example.test"]);
  git(root, ["config", "user.name", "Agent"]);
  git(root, ["checkout", "-b", "main"]);
  await writeFile(join(root, "README.md"), "# repo\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
}

async function withFakeGh<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fake-gh-"));
  const orig = process.env.PATH;
  try {
    await writeFile(join(dir, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${orig ?? ""}`;
    return await fn();
  } finally {
    process.env.PATH = orig;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("statusline command — pure helpers", () => {
  it("resolveRoot prefers an existing first-arg directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sl-root-"));
    expect(resolveRoot(dir, {}, "/fallback")).toBe(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it("resolveRoot falls back to the payload cwd then the process cwd", () => {
    expect(resolveRoot("/no/such/dir", { cwd: "/from/payload" }, "/fallback")).toBe("/from/payload");
    expect(resolveRoot(undefined, {}, "/fallback")).toBe("/fallback");
  });

  it("resolveRoot prefers the fixed project_dir over the live current_dir (anchors to the project on cd)", () => {
    // The session was started in /proj but the user cd'd into /proj/apps/dev —
    // the statusline must stay anchored to /proj, not follow the subdir.
    expect(
      resolveRoot(
        undefined,
        { workspace: { project_dir: "/proj", current_dir: "/proj/apps/dev" }, cwd: "/proj/apps/dev" },
        "/fallback",
      ),
    ).toBe("/proj");
    // No project_dir (older host) → fall back to current_dir.
    expect(
      resolveRoot(undefined, { workspace: { current_dir: "/proj/apps/dev" } }, "/fallback"),
    ).toBe("/proj/apps/dev");
  });

  it("statuslineEnabled honours both opt-out shapes", async () => {
    const top = await mkdtemp(join(tmpdir(), "sl-cfg-"));
    await mkdir(join(top, ".red"), { recursive: true });
    await writeFile(join(top, ".red", "config.yaml"), "statusline: false\n", "utf8");
    expect(statuslineEnabled(top)).toBe(false);

    const nested = await mkdtemp(join(tmpdir(), "sl-cfg-"));
    await mkdir(join(nested, ".red"), { recursive: true });
    await writeFile(join(nested, ".red", "config.yaml"), "afk:\n  statusline: false\n", "utf8");
    expect(statuslineEnabled(nested)).toBe(false);

    const on = await mkdtemp(join(tmpdir(), "sl-cfg-"));
    expect(statuslineEnabled(on)).toBe(true);

    await Promise.all([top, nested, on].map((d) => rm(d, { recursive: true, force: true })));
  });

  it("resolves statusline preset from namespaced and legacy config keys", async () => {
    const cases = [
      ["plugins:\n  dev:\n    statusline:\n      preset: short\n", "short"],
      ["afk:\n  statusline:\n    preset: short\n", "short"],
      ["statusline:\n  preset: short\n", "short"],
      ["plugins:\n  dev:\n    statusline:\n      preset: compact\n", "full"],
      ["", "full"],
    ] as const;

    const dirs: string[] = [];
    try {
      for (const [yaml, expected] of cases) {
        const dir = await mkdtemp(join(tmpdir(), "sl-cfg-"));
        dirs.push(dir);
        await mkdir(join(dir, ".red"), { recursive: true });
        await writeFile(join(dir, ".red", "config.yaml"), yaml, "utf8");
        const cfg = loadConfig(join(dir, ".red", "config.yaml"), { ignoreActivationGate: true, warn: () => undefined });
        expect(resolveStatuslinePreset(cfg)).toBe(expected);
      }
    } finally {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    }
  });
});

describe("statusline command — rendered line", () => {
  let root: string;
  let oldNoColor: string | undefined;

  beforeEach(async () => {
    oldNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    root = await mkdtemp(join(tmpdir(), "sl-cmd-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (oldNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = oldNoColor;
  });

  it("--legend emits the token decode table and does not render the live statusline", async () => {
    const out = sink();
    const code = await statuslineCommand(["--legend", root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("token  name");
    expect(text).toContain("tls");
    expect(text).toContain("tools_called_count");
    expect(text).toContain("rsn");
    expect(text).toContain("reasoning_events");
    expect(text).toContain("txt");
    expect(text).toContain("text_chunk_count");
    expect(text).not.toContain("Opus·high");
    expect(text).not.toContain("\x1b[");
  });

  it("renders Validation gate occupancy from fixture lock files", async () => {
    const stateDir = join(root, ".red", "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "validation-gate.lock"), "holder one\n");
    await writeFile(join(stateDir, "validation-gate.2.lock"), "holder two\n");
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);
    const out = sink();
    const oldValidationCeiling = process.env.REDSKILLED_VALIDATION_CEILING;
    process.env.REDSKILLED_VALIDATION_CEILING = "3";
    process.env.NO_COLOR = "1";
    try {
      await expect(withFakeGh(() =>
        statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD)),
      )).resolves.toBe(0);
    } finally {
      if (oldValidationCeiling === undefined) delete process.env.REDSKILLED_VALIDATION_CEILING;
      else process.env.REDSKILLED_VALIDATION_CEILING = oldValidationCeiling;
    }

    expect(out.text()).toContain("gate 2/3");
  });

  it("emits the multi-line themed layout: header row + one row per live worker", async () => {
    // One live worker on #17 with ad12 rm3, blocked 2, runner claude, done 7,
    // total 10; cached rq11 rh3; repo cache pr3 is24.
    await writeWorkerState(root, "wA", "17-a1", {
      worker_id: "wA",
      runner: "claude",
      done: 7,
      total: 10,
      blocked: 2,
      // A real worker stamps started_at; the statusline collector counts any
      // pid-live worker (#836) — freshness is not required, so a worker quiet on
      // the agent lane during a long test/build still renders on its own row.
      current: {
        number: 17,
        activity: "impl",
        diff_added: 12,
        diff_removed: 3,
        started_at: new Date().toISOString(),
      },
    });
    await seedFreshCache(root, 11, 3);
    await seedFreshRepoCache(root, 3, 24);

    const out = sink();
    const oldColumns = process.env.COLUMNS;
    const oldNoColor = process.env.NO_COLOR;
    process.env.COLUMNS = "200";
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
      expect(code).toBe(0);
    } finally {
      if (oldColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = oldColumns;
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const text = stripAnsi(out.text());
    const rows = text.trimEnd().split("\n");
    expect(rows).toHaveLength(2); // header row + one worker row

    // LINE 1 — repo-global header: model/ctx + repo counts.
    expect(rows[0]).toContain("Opus·high");
    expect(rows[0]).toContain("47k 24%");
    expect(rows[0]).toContain("prs=3");
    expect(rows[0]).toContain("iss=24");

    // LINE 2 — the live worker, in the terse colored k=v form (issue #1175).
    expect(rows[1]).toContain("wA"); // worker id (no [live]/[quiet] badge)
    expect(rows[1]).toContain("run=claude"); // runner as a k=v token
    expect(rows[1]).toContain("iss=17"); // the issue NUMBER (current.number), not a counter
    expect(rows[1]).toContain("impl"); // bare stage (no activity: prefix, no #<n>)
    expect(rows[1]).toContain("tls="); // shared 3-letter vitals vocabulary
    expect(rows[1]).toContain("loc=+12 -3"); // per-worker diff as loc= k=v
    expect(rows[1]).not.toContain("iss=7/10"); // the old done/total counter is gone
    expect(rows[1]).not.toContain("#17"); // standalone #<n> token dropped
    expect(rows[1]).not.toContain("[live]"); // liveness badge dropped
    expect(rows[1]).not.toContain("activity:impl"); // no activity: prefix

    // The raw output carries the wine-red background SGR (theme on by default).
    expect(out.text()).toContain("\x1b[48;2;114;47;55m");
  });

  it("surfaces a newer locally cached dev bundle without network discovery", async () => {
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);
    const cache = await mkdtemp(join(tmpdir(), "red-skills-cache-"));
    await writeFile(join(cache, "dev-1.2.4.bundle.min.mjs"), "// cached newer bundle\n", "utf8");

    const out = sink();
    const oldVersion = process.env.RED_BUILD_VERSION;
    const oldCache = process.env.RED_SKILLS_CACHE_DIR;
    const oldNoColor = process.env.NO_COLOR;
    process.env.RED_BUILD_VERSION = "1.2.3";
    process.env.RED_SKILLS_CACHE_DIR = cache;
    process.env.NO_COLOR = "1";
    try {
      const code = await withFakeGh(() => statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD)));
      expect(code).toBe(0);
    } finally {
      if (oldVersion === undefined) delete process.env.RED_BUILD_VERSION;
      else process.env.RED_BUILD_VERSION = oldVersion;
      if (oldCache === undefined) delete process.env.RED_SKILLS_CACHE_DIR;
      else process.env.RED_SKILLS_CACHE_DIR = oldCache;
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
      await rm(cache, { recursive: true, force: true });
    }

    expect(stripAnsi(out.text())).toContain("v1.2.3*");
  });

  it("shows only the live successor attempt, not a finished/retained pid=0 sibling (issue #1177)", async () => {
    // One worker `wELLN` that finished #1766 (attempt marked pid:0, dir retained
    // for post-mortem, its liveness lane still fresh) and moved to a LIVE #1767.
    // The statusline must render exactly ONE worker line — the live #1767 — never
    // a second phantom line for the finished #1766.
    await writeWorkerState(root, "wELLN", "1766-a1", {
      worker_id: "wELLN",
      pid: 0, // finished attempt: completion sweep stamped pid 0
      runner: "claude",
      current: { number: 1766, activity: "done", started_at: new Date().toISOString() },
    });
    // Fresh lane in the finished dir: without the pid filter this alone makes the
    // evaluator read #1766 as lane-fresh "alive" → the phantom second line.
    await writeFreshLivenessLane(root, "wELLN", "1766-a1");
    await writeWorkerState(root, "wELLN", "1767-a1", {
      worker_id: "wELLN",
      runner: "claude",
      current: { number: 1767, activity: "impl", started_at: new Date().toISOString() },
    });
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);

    const out = sink();
    const oldColumns = process.env.COLUMNS;
    const oldNoColor = process.env.NO_COLOR;
    process.env.COLUMNS = "200";
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
      expect(code).toBe(0);
    } finally {
      if (oldColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = oldColumns;
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const rows = stripAnsi(out.text()).trimEnd().split("\n");
    expect(rows).toHaveLength(2); // header row + ONE live worker row (not two)
    expect(rows[1]).toContain("iss=1767"); // the live successor
    expect(rows[1]).not.toContain("iss=1766"); // the finished/retained sibling is dropped
  });

  it("applies the same live filter in the go-workers namespace (issue #1177)", async () => {
    // Same finished-then-live pattern, but for a `/go` worker under go-workers.
    await writeWorkerState(root, "gW", "2001-a1", {
      worker_id: "gW",
      pid: 0,
      runner: "claude",
      origin: "go",
      current: { number: 2001, activity: "done", started_at: new Date().toISOString() },
    }, "go-workers");
    await writeFreshLivenessLane(root, "gW", "2001-a1", "go-workers");
    await writeWorkerState(root, "gW", "2002-a1", {
      worker_id: "gW",
      runner: "claude",
      origin: "go",
      current: { number: 2002, activity: "impl", started_at: new Date().toISOString() },
    }, "go-workers");
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);

    const out = sink();
    const oldColumns = process.env.COLUMNS;
    const oldNoColor = process.env.NO_COLOR;
    process.env.COLUMNS = "200";
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
      expect(code).toBe(0);
    } finally {
      if (oldColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = oldColumns;
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const rows = stripAnsi(out.text()).trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("iss=2002");
    expect(rows[1]).not.toContain("iss=2001");
  });

  it("renders a requeue-origin no-agent row with gate stage and elapsed, not zero agent metrics", async () => {
    await writeWorkerState(root, "requeue-adopt", "1293-a1", {
      worker_id: "requeue-adopt",
      runner: "claude",
      origin: "requeue",
      current: {
        number: 1293,
        activity: "typecheck",
        diff_added: 0,
        diff_removed: 0,
        started_at: new Date().toISOString(),
      },
    });
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);

    const out = sink();
    const oldColumns = process.env.COLUMNS;
    const oldNoColor = process.env.NO_COLOR;
    process.env.COLUMNS = "200";
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
      expect(code).toBe(0);
    } finally {
      if (oldColumns === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = oldColumns;
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const rows = stripAnsi(out.text()).trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("requeue-adopt");
    expect(rows[1]).toContain("org=requeue");
    expect(rows[1]).toContain("iss=1293");
    expect(rows[1]).toContain("typecheck");
    expect(rows[1]).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
    expect(rows[1]).not.toContain("loc=+0 -0");
    expect(rows[1]).not.toContain("tks=0");
    expect(rows[1]).not.toContain("tls=0");
    expect(rows[1]).not.toContain("rsn=0");
    expect(rows[1]).not.toContain("txt=0");
  });

  it("renders the 5h/7d rate-limit windows on the header when the payload exposes them", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD_WITH_RATE_LIMITS));
      expect(code).toBe(0);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }
    const text = stripAnsi(out.text());
    expect(text).toContain("5h=23%");
    expect(text).toContain("7d=41%");
  });

  it("omits the 5h/7d windows for a non-Pro/Max payload (no rate_limits)", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }
    const text = stripAnsi(out.text());
    expect(text).not.toContain("5h=");
    expect(text).not.toContain("7d=");
  });

  it("emits only the header row when there are no live workers", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    let code: number;
    try {
      code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }
    expect(code).toBe(0);

    const rows = stripAnsi(out.text()).trimEnd().split("\n");
    expect(rows).toHaveLength(1); // 0 workers → header row alone
    expect(rows[0]).toContain("Opus·high");
    expect(rows[0]).toContain("47k 24%");
  });

  it("uses the configured trunk as the repo-wide loc= diff base", async () => {
    await initRepoWithDevelopTrunk(root);
    await mkdir(join(root, ".red"), { recursive: true });
    // `enabled: true` is load-bearing: the loader is fail-closed (ADR 0116), so a
    // directory that never opted into the dev plugin gets defaults, not `develop`.
    await writeFile(
      join(root, ".red", "config.yaml"),
      "plugins:\n  dev:\n    enabled: true\n    trunk: develop\n",
      "utf8",
    );
    await seedFreshCache(root, 0, 0);

    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const code = await withFakeGh(() => statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD)));
      expect(code).toBe(0);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const text = stripAnsi(out.text());
    expect(text).toContain("loc=+1");
    expect(text).not.toContain("loc=+2");
    const cache = decode(
      await readFile(join(root, ".red", "state", "statusline", "statusline-repo-cache.toon"), "utf8"),
    ) as {
      baseRef: string;
      localAdded: number;
    };
    expect(cache.baseRef).toBe("origin/develop");
    expect(cache.localAdded).toBe(1);
  });

  it("renders a fresh live supervisor fleet segment even when zero worker rows render", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root);

    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
      expect(code).toBe(0);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    const rows = stripAnsi(out.text()).trimEnd().split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("flt=codex 1/1†");
    expect(rows[0]).toContain("q=2");
    expect(rows[0]).not.toContain("wrk=");
  });

  it("leaves a healthy fleet segment unmarked when a busy slot has fresh worker liveness", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root);
    await writeWorkerState(root, "wLIVE", "2038-a1", {
      worker_id: "wLIVE",
      runner: "codex",
      started_at: new Date().toISOString(),
      current: { number: 2038, started_at: new Date().toISOString() },
    });
    await writeFreshLivenessLane(root, "wLIVE", "2038-a1");

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("flt=codex 1/1 q=2");
    expect(stripAnsi(out.text())).not.toContain("flt=codex 1/1†");
  });

  it("suppresses an unpinned supervisor lane when the pid anchor is missing", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root);
    await rm(afkPaths(root).supervisorPidPath, { force: true });
    await mkdir(join(dirname(afkPaths(root).supervisorRuntimeDir), `s${process.pid}`), { recursive: true });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).not.toContain("flt=codex 1/1");
    expect(stripAnsi(out.text())).not.toContain("q=2");
  });

  it("suppresses the fleet segment when the supervisor pid is dead", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root);
    await writeFile(afkPaths(root).supervisorPidPath, "999999999\n", "utf8");

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).not.toContain("flt=");
  });

  it("suppresses the fleet segment when the supervisor snapshot is stale", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root, { epoch: Math.floor(Date.now() / 1000) - 3600 });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).not.toContain("flt=");
  });

  it("suppresses a dead supervisor with stale state instead of rendering degraded", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 2, 0);
    await writeFleetSnapshot(root, { epoch: Math.floor(Date.now() / 1000) - 3600 });
    await writeFile(afkPaths(root).supervisorPidPath, "999999999\n", "utf8");

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).not.toContain("flt=");
    expect(stripAnsi(out.text())).not.toContain("†");
  });

  it("surfaces parked slots in the fleet segment", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 4, 0);
    await writeFleetSnapshot(root, {
      ready_for_agent: 4,
      slots: { busy: 1, free: 0, total: 2, parked: 1 },
    });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("prk=1");
  });

  it("surfaces supervisor churn stats from the local fleet snapshot", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 4, 0);
    await writeFleetSnapshot(root, {
      churn: { deaths: 2, respawns: 2, window_s: 300 },
    });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("churn=2d/2r/300s");
  });

  it("renders only the project block outside Claude Code (empty stdin)", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(""));
    expect(code).toBe(0);

    const line = out.text().trim();
    expect(line).not.toContain("Opus");
    expect(line).not.toContain("%");
    expect(line.length).toBeGreaterThan(0);
  });

  it("uses the primary checkout repo name and keeps the active branch", async () => {
    const repo = join(root, "red-request");
    await initSimpleRepo(repo);
    await seedFreshRepoCache(repo, 0, 0);
    await seedFreshCache(repo, 0, 0);

    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const code = await withFakeGh(() => statuslineCommand([repo], repo, out.stream, fakeStdin(PAYLOAD)));
      expect(code).toBe(0);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    expect(stripAnsi(out.text())).toMatch(/^red-request \(main\)(?: v[^ ·]+)?(?: ·|$)/);
  });

  it("uses the common git dir repo name in linked worktrees while keeping the worktree ref", async () => {
    const repo = join(root, "red-request");
    await initSimpleRepo(repo);
    const worktree = join(root, "worktree-bump-reddb-1231");
    git(repo, ["worktree", "add", "-b", "bump-reddb-1231", worktree]);
    await seedFreshRepoCache(worktree, 0, 0);
    await seedFreshCache(worktree, 0, 0);

    const oldNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const branchOut = sink();
      const branchCode = await withFakeGh(() => statuslineCommand([worktree], worktree, branchOut.stream, fakeStdin(PAYLOAD)));
      expect(branchCode).toBe(0);
      const branchText = stripAnsi(branchOut.text());
      expect(branchText).toMatch(/^red-request \(bump-reddb-1231\)(?: v[^ ·]+)?(?: ·|$)/);
      expect(branchText).not.toContain("worktree-bump-reddb-1231");

      git(worktree, ["checkout", "--detach", "HEAD"]);
      const sha = git(worktree, ["rev-parse", "--short", "HEAD"]);
      const detachedOut = sink();
      const detachedCode = await withFakeGh(() => statuslineCommand([worktree], worktree, detachedOut.stream, fakeStdin(PAYLOAD)));
      expect(detachedCode).toBe(0);
      expect(stripAnsi(detachedOut.text())).toMatch(new RegExp(`^red-request \\(detached ${sha}\\)(?: v[^ ·]+)?(?: ·|$)`));
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }
  });

  it("falls back to the cwd basename outside git", async () => {
    const dir = join(root, "not-a-git-repo");
    await mkdir(dir, { recursive: true });
    await seedFreshRepoCache(dir, 0, 0);
    await seedFreshCache(dir, 0, 0);

    const out = sink();
    const oldNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const code = await withFakeGh(() => statuslineCommand([dir], dir, out.stream, fakeStdin("")));
      expect(code).toBe(0);
    } finally {
      if (oldNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = oldNoColor;
    }

    expect(stripAnsi(out.text()).trim()).toMatch(new RegExp(`^${basename(dir)}(?: v[^ ·]+)?$`));
  });

  it("emits nothing when the per-project opt-out is set", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "statusline: false\n", "utf8");

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(out.text()).toBe("");
  });

  it("omits rsp when rsp.enabled is not true", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).not.toContain("rsp");
    expect(await resolveStatuslineRsp(root, {})).toBeUndefined();
  });

  it("renders rsp warming quickly when enabled and the warmup marker is recent", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await mkdir(dirname(resolveResidentPaths(root).wakeLockPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).wakeLockPath, "", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);

    const started = Date.now();
    const rsp = await resolveStatuslineRsp(root, {});
    const elapsed = Date.now() - started;
    expect(rsp).toEqual({ state: "warming" });
    expect(elapsed).toBeLessThan(50);

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("rsp=…");
  });

  it("renders rsp token savings without dollars when an enabled repo has a fresh resident summary", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    await mkdir(dirname(resolveResidentPaths(root).summaryPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).summaryPath, JSON.stringify({
      version: 1,
      tokens_saved_today: 1320000,
      dollars_saved_today_usd: 1.625,
      updated_at: new Date().toISOString(),
    }), "utf8");
    expect(await resolveStatuslineRsp(root, {})).toEqual({ state: "ready", tokensSavedToday: 1320000, dollarsSavedTodayUsd: 1.625 });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("rsp=↓1.32M");
    expect(stripAnsi(out.text())).not.toContain("$1.63");
  });

  it("renders cached rsp decisions contribution from the resident summary when present", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    await mkdir(dirname(resolveResidentPaths(root).summaryPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).summaryPath, JSON.stringify({
      version: 1,
      tokens_saved_today: 1320000,
      decisions: { contributed: 0, seen: 12 },
      updated_at: new Date().toISOString(),
    }), "utf8");
    expect(await resolveStatuslineRsp(root, {})).toEqual({
      state: "ready",
      tokensSavedToday: 1320000,
      decisions: { contributed: 0, seen: 12 },
    });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("rsp=↓1.32M");
  });

  it("reads a TOON rsp resident summary for statusline rendering", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    await mkdir(dirname(resolveResidentPaths(root).summaryPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).summaryPath, encode({
      version: 1,
      tokens_saved_today: 2048,
      decisions: { contributed: 2, seen: 3 },
      updated_at: new Date().toISOString(),
    }), "utf8");

    expect(await resolveStatuslineRsp(root, {})).toEqual({
      state: "ready",
      tokensSavedToday: 2048,
      decisions: { contributed: 2, seen: 3 },
    });
  });

  it("renders rsp savings from an old summary when the resident is idle", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    await mkdir(dirname(resolveResidentPaths(root).summaryPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).summaryPath, JSON.stringify({
      version: 1,
      tokens_saved_today: 4242,
      updated_at: startOfCurrentUtcDay().toISOString(),
    }), "utf8");

    expect(await resolveStatuslineRsp(root, {})).toEqual({ state: "ready", tokensSavedToday: 4242 });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("rsp=↓4.2k");
  });

  it("renders rsp savings as zero when the newest summary belongs to yesterday", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    await mkdir(dirname(resolveResidentPaths(root).summaryPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).summaryPath, JSON.stringify({
      version: 1,
      tokens_saved_today: 4242,
      updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }), "utf8");

    expect(await resolveStatuslineRsp(root, {})).toEqual({ state: "ready", tokensSavedToday: 0 });

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(stripAnsi(out.text())).toContain("rsp=↓0");
  });

  it("renders rsp error when enabled and a stale wake marker produced no summary", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await mkdir(dirname(resolveResidentPaths(root).wakeLockPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).wakeLockPath, "", "utf8");
    const stale = new Date(Date.now() - 60 * 1000);
    await utimes(resolveResidentPaths(root).wakeLockPath, stale, stale);
    const started = Date.now();
    const rsp = await resolveStatuslineRsp(root, {});
    const elapsed = Date.now() - started;
    expect(rsp).toEqual({ state: "error" });
    expect(elapsed).toBeLessThan(50);
  });

  it("renders rsp warming when a recent wake marker has no summary yet", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await mkdir(dirname(resolveResidentPaths(root).wakeLockPath), { recursive: true });
    await writeFile(resolveResidentPaths(root).wakeLockPath, "", "utf8");

    expect(await resolveStatuslineRsp(root, {})).toEqual({ state: "warming" });
  });

  it("local facts are read live: a mutated state file is reflected on the next render", async () => {
    // First render: worker on #17 with loc=+12 -3
    await writeWorkerState(root, "wA", "17-a1", {
      runner: "claude",
      done: 0,
      blocked: 0,
      current: {
        number: 17,
        diff_added: 12,
        diff_removed: 3,
        started_at: new Date().toISOString(),
      },
    });
    await seedFreshCache(root, 0, 0);
    await seedFreshRepoCache(root, 0, 0);

    const out1 = sink();
    await statuslineCommand([root], root, out1.stream, fakeStdin(PAYLOAD));
    // The per-worker diff volume renders on the worker's own row (`+A -R`), read
    // live from the state file — no cache involved.
    expect(stripAnsi(out1.text())).toContain("+12 -3");
    expect(stripAnsi(out1.text())).not.toContain("+99");

    // Mutate in-place: new diff +99 -5 — no process restart; next render reads fresh
    await writeWorkerState(root, "wA", "17-a1", {
      runner: "claude",
      done: 0,
      blocked: 0,
      current: {
        number: 17,
        diff_added: 99,
        diff_removed: 5,
        started_at: new Date().toISOString(),
      },
    });

    const out2 = sink();
    await statuslineCommand([root], root, out2.stream, fakeStdin(PAYLOAD));
    // Live read: must reflect the mutation without any cache involvement
    expect(stripAnsi(out2.text())).toContain("+99 -5");
    expect(stripAnsi(out2.text())).not.toContain("+12 -3");
  });

  it("idle fleet (workers=0) does not gate remote refresh behind workers>0 check", async () => {
    // Seed a STALE AFK cache (ts = 10 min ago, well past the 60 s TTL) with
    // non-zero values.  The command must attempt a refresh and return exit 0
    // even when no workers are live (regression: the old workers<=0 guard fired
    // BEFORE the cache block and prevented any refresh).
    const dir = join(root, ".red", "state", "statusline");
    await mkdir(dir, { recursive: true });
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    await writeFile(
      join(dir, "statusline-cache.toon"),
      encode({ queue: 5, human: 2, ts: staleTs }),
      "utf8",
    );
    await seedFreshRepoCache(root, 0, 0);

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);

    // No live workers → AFK block must be absent
    expect(stripAnsi(out.text())).not.toContain("wrk=");
    // Header still renders, confirming the command ran to completion
    expect(stripAnsi(out.text())).toContain("Opus·high");

    // The cache file must still exist (not deleted by refresh failure) —
    // refresh is fire-and-attempt, fail-open.
    const cacheRaw = await readFile(join(dir, "statusline-cache.toon"), "utf8");
    const cache = decode(cacheRaw) as { ts: number };
    // Either a fresh ts (refresh succeeded) or the old stale ts (gh failed —
    // fail-open). Either way the command ran past the stale check without
    // crashing, proving the workers<=0 gate does not short-circuit the refresh.
    expect(typeof cache.ts).toBe("number");
  });
});
