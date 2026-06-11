import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { initState, isStateLive, readState, updateState } from "../src/core/state.js";

describe("state", () => {
  it("default-parses missing or malformed state files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const missing = await readState(join(dir, "missing.json"));
    expect(missing.version).toBe(1);
    expect(missing.envelope.posted).toBe(false);
    expect(missing.current.stage).toBe("");
  });

  it("writes atomically and supports dotted updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.json");
    await initState(path, { worker_id: "wAAAA", pid: 123, "current.stage": "impl" });
    await updateState(path, { "current.stage": "tests", "envelope.posted": true, queue: [2, 3] });
    const state = await readState(path);
    expect(state.worker_id).toBe("wAAAA");
    expect(state.current.stage).toBe("tests");
    expect(state.envelope.posted).toBe(true);
    expect(state.queue).toEqual([2, 3]);
    expect(await readFile(path, "utf8")).toContain('"version":1');
  });

  it("checks liveness via the injected kill -0 predicate", () => {
    expect(isStateLive({ pid: 0 }, () => true)).toBe(false);
    expect(isStateLive({ pid: 123 }, (pid) => pid === 123)).toBe(true);
    expect(isStateLive({ pid: 123 }, () => false)).toBe(false);
  });

  it("read-shims legacy worker-vitals keys onto their canonical names (ADR 0065)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.json");
    // An OLD afk.state.json written by a pre-S1 bundle: legacy keys only.
    const legacy = {
      version: 1,
      current: {
        diff_added: 120,
        diff_removed: 7,
        thinking_called_count: 5,
        last_progress_at: "2026-06-11T00:00:00.000Z",
      },
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");
    const state = await readState(path);
    // Canonical names carry the legacy values — nothing is lost on read.
    expect(state.current.loc_added).toBe(120);
    expect(state.current.loc_removed).toBe(7);
    expect(state.current.reasoning_events).toBe(5);
    expect(state.current.last_commit_at).toBe("2026-06-11T00:00:00.000Z");
  });

  it("prefers the canonical key over the legacy alias when both are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.json");
    const both = { version: 1, current: { loc_added: 99, diff_added: 1 } };
    await writeFile(path, JSON.stringify(both), "utf8");
    const state = await readState(path);
    expect(state.current.loc_added).toBe(99);
  });
});
