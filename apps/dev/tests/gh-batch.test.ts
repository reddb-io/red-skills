import { describe, expect, it } from "vitest";
import { listIssueStates, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * Boot perf refactor: the three boot sweeps used to issue dozens of SEQUENTIAL
 * `gh issue view N` calls (one per issue). They now read from a SINGLE batched
 * `listIssueStates` map. These tests pin (1) the parse from gh's JSON array into
 * the `number → {state,labels,closedAt}` map, (2) the map-miss contract every
 * lookup relies on, and (3) the call-count win: ONE `gh issue list`, not N
 * views, for K issues.
 */

interface Recorder {
  exec: ExecFn;
  calls: { cmd: string; args: string[] }[];
}

function recording(stdout: string, code = 0): Recorder {
  const calls: { cmd: string; args: string[] }[] = [];
  const out: ExecOutput = { code, stdout, stderr: "" };
  const exec: ExecFn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return Promise.resolve(out);
  };
  return { exec, calls };
}

describe("listIssueStates — batched issue-state fetch", () => {
  it("parses the gh JSON array into a number → {state,labels,closedAt} map", async () => {
    const rec = recording(
      JSON.stringify([
        { number: 1, state: "OPEN", labels: [{ name: "ready-for-agent" }], closedAt: null },
        { number: 2, state: "CLOSED", labels: [{ name: "running" }, { name: "x" }], closedAt: "2026-05-30T00:00:00Z" },
        { number: 3, state: "OPEN", labels: [] },
      ]),
    );
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    const map = await listIssueStates(ctx);

    expect(map.size).toBe(3);
    expect(map.get(1)).toEqual({ state: "OPEN", labels: ["ready-for-agent"], closedAt: null });
    expect(map.get(2)).toEqual({ state: "CLOSED", labels: ["running", "x"], closedAt: "2026-05-30T00:00:00Z" });
    expect(map.get(3)).toEqual({ state: "OPEN", labels: [], closedAt: null });
  });

  it("runs ONE `gh issue list --state all --limit 500` call (not N views)", async () => {
    // 12 issues in the repo — the old boot path would issue 12 `gh issue view`
    // calls (orphan + blocker + branch-meta loops). The batch is ONE list.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      number: i + 1,
      state: "OPEN",
      labels: [],
      closedAt: null,
    }));
    const rec = recording(JSON.stringify(rows));
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };

    const map = await listIssueStates(ctx);

    expect(map.size).toBe(12);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toEqual({
      cmd: "gh",
      args: [
        "issue", "list",
        "--repo", "acme/widgets",
        "--state", "all",
        "--limit", "500",
        "--json", "number,state,labels,closedAt",
      ],
    });
  });

  it("map-miss → get(n) is undefined (lookups degrade to live fallback / not-closed)", async () => {
    const rec = recording(JSON.stringify([{ number: 1, state: "OPEN", labels: [], closedAt: null }]));
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    const map = await listIssueStates(ctx);

    expect(map.has(1)).toBe(true);
    expect(map.get(999)).toBeUndefined();
    // The blocker lookup reads `map.get(n)?.state` — undefined on miss keeps the
    // dependent "open-or-unknown" (NOT promoted), matching the prior 404 path.
    expect(map.get(999)?.state).toBeUndefined();
  });

  it("returns an empty map on a failed probe or unparseable body", async () => {
    const fail: GhContext = { cwd: "/r", repo: "acme/widgets", exec: recording("", 1).exec };
    expect((await listIssueStates(fail)).size).toBe(0);

    const garbage: GhContext = { cwd: "/r", repo: "acme/widgets", exec: recording("not json").exec };
    expect((await listIssueStates(garbage)).size).toBe(0);
  });

  it("omits rows without a usable number", async () => {
    const rec = recording(JSON.stringify([{ state: "OPEN", labels: [] }, { number: 7, state: "CLOSED", labels: [] }]));
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec: rec.exec };
    const map = await listIssueStates(ctx);
    expect([...map.keys()]).toEqual([7]);
  });
});
