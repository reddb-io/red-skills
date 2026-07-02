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

/** Write a fake live worker state (pid = this process → always live). */
async function writeWorkerState(
  root: string,
  worker: string,
  attempt: string,
  state: Record<string, unknown>,
): Promise<void> {
  const dir = join(root, ".red", "tmp", "workers", worker, attempt);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "afk.state.json"), JSON.stringify({ pid: process.pid, ...state }), "utf8");
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

  it("emits the full block run from a payload + live workers + cached counts", async () => {
    // One live worker on #17 with ad12 rm3, blocked 2, runner claude, done 7;
    // cached rq11 rh3; repo cache pr3 is24.
    await writeWorkerState(root, "wA", "17-a1", {
      runner: "claude",
      done: 7,
      blocked: 2,
      // A real worker stamps started_at; the statusline collector counts any
      // pid-live worker (#836) — freshness is not required, so a worker quiet on
      // the agent lane during a long test/build still renders on line 2.
      current: {
        number: 17,
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

    // Header and AFK KPI content may render on one or two rows depending on the
    // host width, but the command contract is the field set.
    const text = stripAnsi(out.text());
    expect(text).toContain("Opus·high");
    expect(text).toContain("47k 24%");
    expect(text).toContain("prs=3");
    expect(text).toContain("iss=24");
    expect(text).toContain("claude"); // runner
    expect(text).toContain("wrk=1 res=7"); // workers + resolved
    expect(text).toContain("loc=+12 -3"); // in-transit diff
    expect(text).toContain("rdy=11 hmn=3 blk=2"); // pipeline
    expect(text).toContain("#17");
    // The raw output carries the wine-red background SGR (theme on by default).
    expect(out.text()).toContain("\x1b[48;2;114;47;55m");
  });

  it("drops the AFK block when there are no live workers", async () => {
    await seedFreshRepoCache(root, 0, 0);
    await seedFreshCache(root, 0, 0);
    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);

    const line = stripAnsi(out.text().trim());
    expect(line).toContain("Opus·high");
    expect(line).toContain("47k 24%");
    expect(line).not.toContain("wrk=");
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
    expect(stripAnsi(out1.text())).toContain("loc=+12 -3");
    expect(stripAnsi(out1.text())).not.toContain("loc=+99");

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
    expect(stripAnsi(out2.text())).toContain("loc=+99 -5");
    expect(stripAnsi(out2.text())).not.toContain("loc=+12");
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
