import { mkdtemp, readFile } from "node:fs/promises";
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
});
