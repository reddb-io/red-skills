import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { decode, encode } from "@reddb-io/toon";
import { tokenToAnsiBackground } from "@reddb-io/brand-tokens";
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
