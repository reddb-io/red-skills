import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  initState,
  initStateSync,
  isStateActive,
  isStateLive,
  readPidStartTime,
  readState,
  updateState,
  WORKER_LIVE_MAX_AGE_S,
} from "../src/core/state.js";
import { AfkStateSchema } from "../src/types/state.js";

describe("state", () => {
  it("falls back to a portable process-start token when procfs is unavailable", () => {
    const token = readPidStartTime(4242, {
      readProcStat: () => {
        throw new Error("procfs unavailable");
      },
      readPsStart: () => "Tue Jul 22 07:00:01 2026",
    });

    expect(token).toBe("ps:Tue Jul 22 07:00:01 2026");
  });

  it("default-parses missing or malformed state files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const missing = await readState(join(dir, "missing.json"));
    expect(missing.version).toBe(1);
    expect(missing.envelope.posted).toBe(false);
    expect(missing.current.activity).toBe("");
  });

  it("writes atomically and supports dotted updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");
    await initState(path, { worker_id: "wAAAA", pid: 123, "current.activity": "impl" });
    await updateState(path, { "current.activity": "tests", "envelope.posted": true, queue: [2, 3] });
    const state = await readState(path);
    expect(state.worker_id).toBe("wAAAA");
    expect(state.current.activity).toBe("tests");
    expect(state.envelope.posted).toBe(true);
    expect(state.queue).toEqual([2, 3]);
    const onDisk = decode(await readFile(path, "utf8")) as { version?: number };
    expect(onDisk.version).toBe(1);
  });

  it("round-trips resolved base provenance fields through state updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");
    await initState(path, { worker_id: "wAAAA", pid: 123, "current.activity": "setup" });

    await updateState(path, {
      "current.base": "main",
      "current.base_ref": "origin/main",
      "current.base_sha": "feedface",
      "current.base_source": "remote",
      "current.base_remote_reachable": true,
      "current.base_local_sha": "badc0de",
      "current.base_local_ahead": 0,
      "current.base_local_behind": 4,
    });

    const state = await readState(path);
    expect(state.current).toMatchObject({
      base: "main",
      base_ref: "origin/main",
      base_sha: "feedface",
      base_source: "remote",
      base_remote_reachable: true,
      base_local_sha: "badc0de",
      base_local_ahead: 0,
      base_local_behind: 4,
    });
  });

  it("initStateSync seeds identity synchronously so a later updateState preserves it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    // Synchronous seed — the file MUST exist with full identity the instant the
    // call returns (the whole point: it beats the async sink's read-modify-write).
    const seeded = initStateSync(path, {
      worker_id: "wL30L",
      pid: 4242,
      "current.number": 583,
      "current.activity": "setup",
    });
    expect(seeded.pid).toBe(4242);
    const onDisk = decode(await readFile(path, "utf8")) as {
      worker_id?: string;
      current?: { number?: number };
    };
    expect(onDisk.worker_id).toBe("wL30L");
    expect(onDisk.current?.number).toBe(583);

    // A subsequent vitals patch must NOT clobber the identity (the bug was the
    // sink seeding from DEFAULT and stranding the worker with no pid/number).
    const after = await updateState(path, { "current.cost_usd": 4.01, "current.activity": "tests" });
    expect(after.pid).toBe(4242);
    expect(after.worker_id).toBe("wL30L");
    expect(after.current.number).toBe(583);
    expect(after.current.cost_usd).toBe(4.01);
    expect(after.current.activity).toBe("tests");
  });

  it("records and preserves the castle worker kind under current.kind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    initStateSync(path, {
      worker_id: "wGO12",
      pid: 4242,
      origin: "go",
      "current.kind": "go",
      "current.number": 1916,
      "current.activity": "setup",
    });

    const seeded = await readState(path);
    expect(seeded.current.kind).toBe("go");
    const after = await updateState(path, {
      origin: "",
      current: { kind: "", activity: "tests" },
    });
    expect(after.origin).toBe("go");
    expect(after.current.kind).toBe("go");
    expect(after.current.activity).toBe("tests");
  });

  it("preserves stamped identity, vitals, and loc when a stage writer carries default identity fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    initStateSync(path, {
      worker_id: "w8UV2",
      pid: 4242,
      pid_start_time: "12345",
      runner: "codex",
      origin: "afk",
      started_at: "2026-07-06T20:00:00.000Z",
      "current.number": 1238,
      "current.runner": "codex",
      "current.model": "gpt-5",
      "current.effort": "high",
      "current.activity": "setup",
      "current.phase": "setup",
      "current.tools_called_count": 9,
      "current.loc_added": 22,
      "current.loc_removed": 3,
      "current.last_event_at": "2026-07-06T20:01:00.000Z",
    });

    const after = await updateState(path, {
      worker_id: "",
      pid: 0,
      pid_start_time: "",
      runner: "",
      origin: "",
      started_at: "",
      current: {
        number: "",
        runner: "",
        model: "",
        effort: "",
        activity: "impl",
      },
    });

    expect(after.worker_id).toBe("w8UV2");
    expect(after.pid).toBe(4242);
    expect(after.pid_start_time).toBe("12345");
    expect(after.runner).toBe("codex");
    expect(after.origin).toBe("afk");
    expect(after.started_at).toBe("2026-07-06T20:00:00.000Z");
    expect(after.current.number).toBe(1238);
    expect(after.current.runner).toBe("codex");
    expect(after.current.model).toBe("gpt-5");
    expect(after.current.effort).toBe("high");
    expect(after.current.activity).toBe("impl");
    expect(after.current.tools_called_count).toBe(9);
    expect(after.current.loc_added).toBe(22);
    expect(after.current.loc_removed).toBe(3);
    expect(after.current.last_event_at).toBe("2026-07-06T20:01:00.000Z");
  });

  it("replaces the provisional spawn model with the resolved issue route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    initStateSync(path, {
      worker_id: "wROUT",
      pid: 4242,
      "current.model": "claude-think-model",
      "current.effort": "high",
    });

    const after = await updateState(path, {
      "current.model_tier": "simple",
      "current.model": "claude-simple-model",
      "current.effort": "medium",
    });

    expect(after.current).toMatchObject({
      model_tier: "simple",
      model: "claude-simple-model",
      effort: "medium",
    });
  });

  it("preserves live pid and current identity when stamping the validating phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    initStateSync(path, {
      worker_id: "wSVD3",
      pid: 263126,
      runner: "codex",
      "current.number": 1238,
      "current.runner": "codex",
      "current.model": "gpt-5",
      "current.effort": "high",
      "current.activity": "tests",
      "current.phase": "coding",
    });

    const after = await updateState(path, {
      worker_id: "",
      pid: 0,
      runner: "",
      "current.number": "",
      "current.runner": "",
      "current.model": "",
      "current.effort": "",
      "current.phase": "validating",
    });

    expect(after.worker_id).toBe("wSVD3");
    expect(after.pid).toBe(263126);
    expect(after.runner).toBe("codex");
    expect(after.current).toMatchObject({
      number: 1238,
      runner: "codex",
      model: "gpt-5",
      effort: "high",
      activity: "tests",
      phase: "validating",
    });
  });

  it("only allows pid to reset to zero when the caller marks a real teardown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");

    initStateSync(path, { worker_id: "wLIVE", pid: 99, "current.number": 1238 });

    const phase = await updateState(path, { pid: 0, "current.phase": "validating" });
    expect(phase.pid).toBe(99);

    const terminal = await updateState(path, { pid: 0 }, { allowPidReset: true });
    expect(terminal.pid).toBe(0);
  });

  it("checks liveness via the injected kill -0 predicate", () => {
    expect(isStateLive({ pid: 0 }, () => true)).toBe(false);
    expect(isStateLive({ pid: 123 }, (pid) => pid === 123)).toBe(true);
    expect(isStateLive({ pid: 123 }, () => false)).toBe(false);
  });

  it("rejects pid reuse when pid_start_time is present and mismatched", () => {
    const alive = (pid: number): boolean => pid === 123;
    expect(isStateLive({ pid: 123, pid_start_time: "old" }, alive, () => "old")).toBe(true);
    expect(isStateLive({ pid: 123, pid_start_time: "old" }, alive, () => "new")).toBe(false);
    expect(isStateLive({ pid: 123, pid_start_time: "old" }, alive, () => null)).toBe(true);
    // Legacy/unavailable identity remains pid-only for compatibility.
    expect(isStateLive({ pid: 123, pid_start_time: "" }, alive, () => "new")).toBe(true);
  });

  it("isStateActive requires BOTH a resolving pid AND recent activity (ADR 0065)", () => {
    const now = Date.parse("2026-06-11T20:00:00.000Z");
    const alive = () => true;
    const fresh = AfkStateSchema.parse({
      pid: 123,
      current: { last_event_at: new Date(now - 5_000).toISOString() },
    });
    const stale = AfkStateSchema.parse({
      pid: 123,
      current: { last_event_at: new Date(now - (WORKER_LIVE_MAX_AGE_S + 60) * 1000).toISOString() },
    });

    // pid-live + fresh activity → active
    expect(isStateActive(fresh, now, alive)).toBe(true);
    expect(isStateActive({ ...fresh, pid_start_time: "old" }, now, alive, undefined, () => "new")).toBe(false);
    // pid-live but activity older than the ceiling → NOT active (the phantom case:
    // a finished worker whose pid is shared/recycled still resolves).
    expect(isStateActive(stale, now, alive)).toBe(false);
    // dead pid is never active regardless of freshness
    expect(isStateActive(fresh, now, () => false)).toBe(false);
    // a committing-but-quiet worker (no recent event, recent commit) stays active
    const committing = AfkStateSchema.parse({
      pid: 123,
      current: {
        last_event_at: new Date(now - (WORKER_LIVE_MAX_AGE_S + 60) * 1000).toISOString(),
        last_commit_at: new Date(now - 10_000).toISOString(),
      },
    });
    expect(isStateActive(committing, now, alive)).toBe(true);
  });

  it("read-shims legacy worker-vitals keys onto their canonical names (ADR 0065)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-state-"));
    const path = join(dir, "afk.state.toon");
    // An OLD afk.state.toon written by a pre-S1 bundle: legacy keys only.
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
    const path = join(dir, "afk.state.toon");
    const both = { version: 1, current: { loc_added: 99, diff_added: 1 } };
    await writeFile(path, JSON.stringify(both), "utf8");
    const state = await readState(path);
    expect(state.current.loc_added).toBe(99);
  });
});
