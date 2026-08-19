import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { afkStateDir, legacyAfkStateDir, stateDir, statuslineStateDir, tmpDir } from "@reddb-io/shared/red-paths.js";
import { readCastleHistoryRecords } from "@reddb-io/worker/engine";
import { migrateLegacyDevPaths } from "../src/runtime/red-path-migration.js";

const roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-path-mig-"));
  roots.push(root);
  await mkdir(tmpDir(root), { recursive: true });
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function supervisorDir(root: string): string {
  return join(tmpDir(root), "supervisors", "default");
}

afterEach(() => {
  // temp dirs live under the OS tmp; leave them for the OS reaper.
  roots.length = 0;
});

describe("migrateLegacyDevPaths", () => {
  it("relocates legacy durable artifacts and live supervisor artifacts to their split lanes", async () => {
    const root = await freshRoot();
    const tmp = tmpDir(root);
    await writeFile(join(tmp, "afk-supervisor.pid"), "123", "utf8");
    await writeFile(join(tmp, "afk-supervisor-boot.pid"), "456", "utf8");
    await writeFile(join(tmp, "afk-supervisor.state.json"), "state", "utf8");
    await writeFile(join(tmp, "statusline-cache.json"), "{}", "utf8");
    await writeFile(join(tmp, "afk-supervisor.log"), "log", "utf8");
    await writeFile(join(tmp, "afk-supervisor.log.toonl"), "{}", "utf8");
    await writeFile(join(tmp, "monitor-log-cursors.json"), "cursors", "utf8");
    await mkdir(join(tmp, "runner-circuit"), { recursive: true });
    await writeFile(join(tmp, "runner-circuit", "claude.json"), "{}", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(await readFile(join(supervisorDir(root), "afk-supervisor.pid"), "utf8")).toBe("123");
    expect(await readFile(join(supervisorDir(root), "afk-supervisor-boot.pid"), "utf8")).toBe("456");
    expect(await readFile(join(supervisorDir(root), "state.toon"), "utf8")).toBe("state");
    expect(await readFile(join(statuslineStateDir(root), "statusline-cache.toon"), "utf8")).toBe("{}");
    expect(await readFile(join(supervisorDir(root), "supervisor.log.toonl"), "utf8")).toBe("{}");
    expect(await readFile(join(supervisorDir(root), "monitor-log-cursors.toon"), "utf8")).toBe("cursors");
    expect(await readFile(join(supervisorDir(root), "runner-circuit", "claude.json"), "utf8")).toBe("{}");
    expect(await exists(join(afkStateDir(root), "afk-supervisor.pid"))).toBe(false);
    expect(await exists(join(afkStateDir(root), "afk-supervisor.log.toonl"))).toBe(false);
    // Legacy copies are gone (moved, not copied).
    expect(await exists(join(tmp, "afk-supervisor.pid"))).toBe(false);
    // The retired human prose log is not dual-written into a new lane.
    expect(await readFile(join(tmp, "afk-supervisor.log"), "utf8")).toBe("log");
    expect(moved).toContain("afk-supervisor.pid");
    expect(moved).toContain("afk-supervisor.log.toonl");
  });

  it("renames legacy statusline state cache files to .toon", async () => {
    const root = await freshRoot();
    const statusline = statuslineStateDir(root);
    await mkdir(statusline, { recursive: true });
    await writeFile(join(statusline, "statusline-cache.json"), "cache", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(await readFile(join(statusline, "statusline-cache.toon"), "utf8")).toBe("cache");
    expect(await exists(join(statusline, "statusline-cache.json"))).toBe(false);
    expect(moved).toContain("state/statusline-cache.json");
  });

  it("is a no-op on a second boot (idempotent)", async () => {
    const root = await freshRoot();
    await writeFile(join(tmpDir(root), "afk-supervisor.pid"), "9", "utf8");
    await migrateLegacyDevPaths(root);
    const second = await migrateLegacyDevPaths(root);
    expect(second.moved).toEqual([]);
    expect(await readFile(join(supervisorDir(root), "afk-supervisor.pid"), "utf8")).toBe("9");
  });

  it("relocates already-state-tier legacy AFK artifacts to the split castle and supervisor lanes", async () => {
    const root = await freshRoot();
    const legacyAfk = legacyAfkStateDir(root);
    await mkdir(join(legacyAfk, "runner-circuit"), { recursive: true });
    await writeFile(join(legacyAfk, "afk-supervisor.pid"), "321", "utf8");
    await writeFile(join(legacyAfk, "afk-supervisor.state.json"), "state", "utf8");
    await writeFile(join(legacyAfk, "afk-supervisor.log.toonl"), "[0]{ts,msg}:\n", "utf8");
    await writeFile(join(legacyAfk, "afk-supervisor.log"), "human\n", "utf8");
    await writeFile(join(legacyAfk, "runner-circuit", "codex.json"), "{}", "utf8");
    await writeFile(join(stateDir(root), "afk-history.toonl"), "[0]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:\n", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(await readFile(join(supervisorDir(root), "afk-supervisor.pid"), "utf8")).toBe("321");
    expect(await readFile(join(supervisorDir(root), "state.toon"), "utf8")).toBe("state");
    expect(await readFile(join(supervisorDir(root), "supervisor.log.toonl"), "utf8")).toBe("[0]{ts,msg}:\n");
    expect(await readFile(join(supervisorDir(root), "runner-circuit", "codex.json"), "utf8")).toBe("{}");
    expect(await readFile(join(afkStateDir(root), "history.toonl"), "utf8")).toBe(
      "[0]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:\n",
    );
    expect(await exists(join(legacyAfk, "afk-supervisor.pid"))).toBe(false);
    expect(await readFile(join(legacyAfk, "afk-supervisor.log"), "utf8")).toBe("human\n");
    expect(await exists(join(stateDir(root), "afk-history.toonl"))).toBe(false);
    expect(moved).toContain("state/afk/afk-supervisor.pid");
    expect(moved).toContain("afk-history.toonl");
  });

  it("moves live supervisor artifacts out of state/castle when a previous boot stranded them there", async () => {
    const root = await freshRoot();
    const castle = afkStateDir(root);
    await mkdir(join(castle, "runner-circuit"), { recursive: true });
    await writeFile(join(castle, "afk-supervisor.pid"), "654", "utf8");
    await writeFile(join(castle, "afk-supervisor.log.toonl"), "[0]{ts,msg}:\n", "utf8");
    await writeFile(join(castle, "monitor-log-cursors.json"), "cursors", "utf8");
    await writeFile(join(castle, "runner-circuit", "codex.json"), "{}", "utf8");
    await writeFile(join(castle, "history.toonl"), "", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(await readFile(join(supervisorDir(root), "afk-supervisor.pid"), "utf8")).toBe("654");
    expect(await readFile(join(supervisorDir(root), "supervisor.log.toonl"), "utf8")).toBe("[0]{ts,msg}:\n");
    expect(await readFile(join(supervisorDir(root), "monitor-log-cursors.toon"), "utf8")).toBe("cursors");
    expect(await readFile(join(supervisorDir(root), "runner-circuit", "codex.json"), "utf8")).toBe("{}");
    expect(await exists(join(castle, "afk-supervisor.pid"))).toBe(false);
    expect(await exists(join(castle, "afk-supervisor.log.toonl"))).toBe(false);
    expect(await readFile(join(castle, "history.toonl"), "utf8")).toBe("");
    expect(moved).toContain("state/castle/afk-supervisor.pid");
    expect(moved).toContain("state/castle/afk-supervisor.log.toonl");
  });

  it("converts legacy JSONL history into castle TOONL when no castle history exists", async () => {
    const root = await freshRoot();
    await mkdir(stateDir(root), { recursive: true });
    await writeFile(
      join(stateDir(root), "afk-history.jsonl"),
      `${JSON.stringify({ ts: "t", epoch: 1, worker: "wA", issue: 1, event: "done", duration_s: 2, runner: "codex" })}\n`,
      "utf8",
    );

    const { moved } = await migrateLegacyDevPaths(root);
    const converted = await readCastleHistoryRecords(join(afkStateDir(root), "history.toonl"));

    expect(converted).toEqual([expect.objectContaining({ ts: "t", issue: 1, event: "done", runner: "codex" })]);
    expect(await exists(join(stateDir(root), "afk-history.jsonl"))).toBe(false);
    expect(moved).toContain("afk-history.jsonl");
  });

  it("never deletes the legacy copy when the canonical copy already exists (ambiguous)", async () => {
    const root = await freshRoot();
    const legacy = join(tmpDir(root), "afk-supervisor.pid");
    const current = join(supervisorDir(root), "afk-supervisor.pid");
    await writeFile(legacy, "legacy", "utf8");
    await mkdir(supervisorDir(root), { recursive: true });
    await writeFile(current, "current", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(moved).not.toContain("afk-supervisor.pid");
    expect(await readFile(legacy, "utf8")).toBe("legacy");
    expect(await readFile(current, "utf8")).toBe("current");
  });
});
