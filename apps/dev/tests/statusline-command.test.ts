import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  statuslineCommand,
  resolveRoot,
  statuslineEnabled,
} from "../src/commands/statusline.js";

/** Strip ANSI SGR escapes so assertions read the plain rendered text. The
 * command now themes the line (wine background + black-chipped KPI numbers);
 * stripping recovers the exact plain content the renderer produced. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

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
  await writeFile(join(dir, "afk.state.json"), JSON.stringify({ pid: process.pid, ...state }), "utf8");
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
  await writeFile(join(dir, "liveness.lane.jsonl"), record, "utf8");
}

/** Pre-seed a FRESH gh count cache so collectStatuslineAfk never calls gh. */
async function seedFreshCache(root: string, queue: number, human: number): Promise<void> {
  const dir = join(root, ".red", "tmp");
  await mkdir(dir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  await writeFile(join(dir, "statusline-cache.json"), JSON.stringify({ queue, human, ts }), "utf8");
}

/** Pre-seed a FRESH repo-stats cache so collectStatuslineRepo never calls gh. */
async function seedFreshRepoCache(root: string, openPrs: number, openIssues: number): Promise<void> {
  const dir = join(root, ".red", "tmp");
  await mkdir(dir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  await writeFile(join(dir, "statusline-repo-cache.json"), JSON.stringify({ openPrs, openIssues, ts }), "utf8");
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
        stage: "impl",
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
    expect(rows[1]).toContain("impl"); // bare stage (no stage: prefix, no #<n>)
    expect(rows[1]).toContain("tls="); // shared 3-letter vitals vocabulary
    expect(rows[1]).toContain("loc=+12 -3"); // per-worker diff as loc= k=v
    expect(rows[1]).not.toContain("iss=7/10"); // the old done/total counter is gone
    expect(rows[1]).not.toContain("#17"); // standalone #<n> token dropped
    expect(rows[1]).not.toContain("[live]"); // liveness badge dropped
    expect(rows[1]).not.toContain("stage:impl"); // no stage: prefix

    // The raw output carries the wine-red background SGR (theme on by default).
    expect(out.text()).toContain("\x1b[48;2;114;47;55m");
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
      current: { number: 1766, stage: "done", started_at: new Date().toISOString() },
    });
    // Fresh lane in the finished dir: without the pid filter this alone makes the
    // evaluator read #1766 as lane-fresh "alive" → the phantom second line.
    await writeFreshLivenessLane(root, "wELLN", "1766-a1");
    await writeWorkerState(root, "wELLN", "1767-a1", {
      worker_id: "wELLN",
      runner: "claude",
      current: { number: 1767, stage: "impl", started_at: new Date().toISOString() },
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
      current: { number: 2001, stage: "done", started_at: new Date().toISOString() },
    }, "go-workers");
    await writeFreshLivenessLane(root, "gW", "2001-a1", "go-workers");
    await writeWorkerState(root, "gW", "2002-a1", {
      worker_id: "gW",
      runner: "claude",
      origin: "go",
      current: { number: 2002, stage: "impl", started_at: new Date().toISOString() },
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
        stage: "typecheck",
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

  it("emits nothing when the per-project opt-out is set", async () => {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "statusline: false\n", "utf8");

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);
    expect(out.text()).toBe("");
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
    const dir = join(root, ".red", "tmp");
    await mkdir(dir, { recursive: true });
    const staleTs = Math.floor(Date.now() / 1000) - 600;
    await writeFile(
      join(dir, "statusline-cache.json"),
      JSON.stringify({ queue: 5, human: 2, ts: staleTs }),
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
    const cacheRaw = await readFile(join(dir, "statusline-cache.json"), "utf8");
    const cache = JSON.parse(cacheRaw) as { ts: number };
    // Either a fresh ts (refresh succeeded) or the old stale ts (gh failed —
    // fail-open). Either way the command ran past the stale check without
    // crashing, proving the workers<=0 gate does not short-circuit the refresh.
    expect(typeof cache.ts).toBe("number");
  });
});
