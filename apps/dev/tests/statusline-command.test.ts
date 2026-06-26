import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);

    // Two powerline rows: header (project/model/ctx/pr·is) + AFK (runner/wk·res/
    // in-transit/pipeline/issues).
    const rows = out.text().trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    const l1 = stripAnsi(rows[0]);
    const l2 = stripAnsi(rows[1]);
    expect(l1).toContain("Opus·high");
    expect(l1).toContain("47k 24%");
    expect(l1).toContain("prs=3");
    expect(l1).toContain("iss=24");
    expect(l2).toContain("claude"); // runner
    expect(l2).toContain("wrk=1 res=7"); // workers + resolved
    expect(l2).toContain("loc=+12 -3"); // in-transit diff
    expect(l2).toContain("rdy=11 hmn=3 blk=2"); // pipeline
    expect(l2).toContain("#17");
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
    expect(line).not.toContain("wk");
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
});
