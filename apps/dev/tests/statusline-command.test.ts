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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sl-cmd-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits the full block run from a payload + live workers + cached counts", async () => {
    // One live worker on #17 with +12 -3, blocked 2; cached 📋11 🆘3.
    await writeWorkerState(root, "wA", "17-a1", {
      blocked: 2,
      // `started_at` (fresh) is what makes isStateActive treat this pid-live worker
      // as active (ADR 0065): the statusline collector now requires recent activity,
      // not just a resolving pid. A real worker always stamps started_at.
      current: {
        number: 17,
        diff_added: 12,
        diff_removed: 3,
        started_at: new Date().toISOString(),
      },
    });
    await seedFreshCache(root, 11, 3);

    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);

    const line = out.text().trim();
    // basename(root) (branch may or may not resolve) · Opus·high · 47k 24% · AFK run.
    expect(line).toContain("Opus·high");
    expect(line).toContain("47k 24%");
    expect(line).toContain("🤖1 📋11 🆘3 🚧2 +12 -3 #17");
  });

  it("drops the AFK block when there are no live workers", async () => {
    const out = sink();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(PAYLOAD));
    expect(code).toBe(0);

    const line = out.text().trim();
    expect(line).toContain("Opus·high");
    expect(line).toContain("47k 24%");
    expect(line).not.toContain("🤖");
  });

  it("renders only the project block outside Claude Code (empty stdin)", async () => {
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
