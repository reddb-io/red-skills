import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decode, encode } from "@reddb-io/toon";
import {
  DEV_TOON_MIGRATION_SURFACES,
  MEMORY_TOON_MIGRATION_SURFACES,
  convertRegisteredToonSurfaces,
  readRegisteredToonSurface,
  registeredToonSurfacesForPlugin,
} from "./toon-migration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtempCompat("shared-toon-migration-");
  roots.push(root);
  return root;
}

async function mkdtempCompat(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(root: string, rel: string, body: string): Promise<string> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("shared TOON migration registry", () => {
  test("registers a memory-owned proof surface", () => {
    expect(MEMORY_TOON_MIGRATION_SURFACES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory.config",
          plugin: "memory",
          legacyPath: ".red/memory/config.json",
          toonPath: ".red/memory/config.toon",
          kind: "toon",
        }),
      ]),
    );
    expect(registeredToonSurfacesForPlugin("memory").map((surface) => surface.id)).toContain("memory.config");
    expect(DEV_TOON_MIGRATION_SURFACES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dev.afk-history",
          plugin: "dev",
          legacyPath: ".red/state/afk-history.jsonl",
          toonPath: ".red/state/afk-history.toonl",
          kind: "toonl",
        }),
        expect.objectContaining({
          id: "dev.agent-log",
          plugin: "dev",
          legacyPath: ".red/tmp/agent.log.jsonl",
          toonPath: ".red/tmp/agent.log.toonl",
          kind: "toonl",
        }),
        expect.objectContaining({
          id: "dev.code-understanding-bench-runs",
          plugin: "dev",
          legacyPath: ".red/tmp/bench/code-understanding/runs.jsonl",
          toonPath: ".red/tmp/bench/code-understanding/runs.toonl",
          kind: "toonl",
        }),
        expect.objectContaining({
          id: "dev.attempt-state",
          plugin: "dev",
          legacyPath: ".red/tmp/{workers,go-workers,scout-workers}/*/*/afk.state.json",
          toonPath: ".red/tmp/{workers,go-workers,scout-workers}/*/*/afk.state.json",
          kind: "toon",
        }),
        expect.objectContaining({
          id: "dev.statusline-count-cache",
          plugin: "dev",
          legacyPath: ".red/tmp/statusline-cache.json",
          toonPath: ".red/tmp/statusline-cache.json",
          kind: "toon",
        }),
        expect.objectContaining({
          id: "dev.statusline-repo-cache",
          plugin: "dev",
          legacyPath: ".red/tmp/statusline-repo-cache.json",
          toonPath: ".red/tmp/statusline-repo-cache.json",
          kind: "toon",
        }),
        expect.objectContaining({
          id: "dev.rsp-resident-registry",
          plugin: "dev",
          legacyPath: ".red/tmp/rsp-resident.pid.json",
          toonPath: ".red/tmp/rsp-resident.pid.json",
          kind: "toon",
        }),
        expect.objectContaining({
          id: "dev.rsp-status-summary",
          plugin: "dev",
          legacyPath: ".red/tmp/rsp-status-summary.json",
          toonPath: ".red/tmp/rsp-status-summary.json",
          kind: "toon",
        }),
        expect.objectContaining({
          id: "dev.rsp-wait-registry",
          plugin: "dev",
          legacyPath: ".red/tmp/waits/*.json",
          toonPath: ".red/tmp/waits/*.json",
          kind: "toon",
        }),
      ]),
    );
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.afk-history");
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.agent-log");
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.code-understanding-bench-runs");
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.attempt-state");
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.rsp-wait-registry");
  });

  test("refuses while fleet or residents are active and explains why", async () => {
    const root = await scratch();
    await write(root, ".red/memory/config.json", JSON.stringify({ mode: "graph" }));
    await write(root, ".red/tmp/afk-supervisor.pid", `${process.pid}\n`);
    await write(root, ".red/tmp/rsp-resident.pid.json", JSON.stringify({ pid: process.pid }));

    const report = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "memory" });

    expect(report.status).toBe("refused");
    expect(report.reasons.join("\n")).toContain("active fleet supervisor");
    expect(report.reasons.join("\n")).toContain("active rsp resident");
    expect(report.converted).toHaveLength(0);
    expect(await exists(join(root, ".red/memory/config.toon"))).toBe(false);
  });

  test("converts legacy JSON idempotently when quiesced", async () => {
    const root = await scratch();
    const legacy = await write(root, ".red/memory/config.json", `${JSON.stringify({ mode: "graph", hooks: { sessionStart: true } })}\n`);

    const first = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "memory" });
    const toonPath = join(root, ".red/memory/config.toon");
    const afterFirst = await readFile(toonPath, "utf8");
    const legacyAfterFirst = await readFile(legacy, "utf8");
    const second = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "memory" });

    expect(first.status).toBe("converted");
    expect(first.converted).toEqual(["memory.config"]);
    expect(legacyAfterFirst).toBe(`${JSON.stringify({ mode: "graph", hooks: { sessionStart: true } })}\n`);
    expect(second.status).toBe("noop");
    expect(second.skipped).toEqual(["memory.config"]);
    expect(await readFile(toonPath, "utf8")).toBe(afterFirst);
  });

  test("format-sniff helper reads legacy JSON and converted TOON", async () => {
    const root = await scratch();
    await write(root, ".red/memory/config.json", JSON.stringify({ mode: "markdown-only" }));

    await expect(readRegisteredToonSurface(root, "memory.config")).resolves.toMatchObject({
      format: "json",
      value: { mode: "markdown-only" },
    });

    await write(root, ".red/memory/config.toon", encode({ mode: "graph", storePath: ".red/memory/graph.rdb" }));

    await expect(readRegisteredToonSurface(root, "memory.config")).resolves.toMatchObject({
      format: "toon",
      value: { mode: "graph", storePath: ".red/memory/graph.rdb" },
    });
  });

  test("converts legacy AFK history JSONL to TOONL once and reads the converted file", async () => {
    const root = await scratch();
    await write(
      root,
      ".red/state/afk-history.jsonl",
      [
        JSON.stringify({ ts: "t1", epoch: 1, worker: "wA", issue: 1, event: "done", duration_s: 0, runner: "codex" }),
        JSON.stringify({ ts: "t2", epoch: 2, worker: "wB", issue: 2, event: "blocked", duration_s: 3, runner: "claude", reason: "no-sentinel" }),
        "",
      ].join("\n"),
    );

    await expect(readRegisteredToonSurface(root, "dev.afk-history")).resolves.toMatchObject({
      format: "jsonl",
      value: [
        expect.objectContaining({ ts: "t1", issue: 1 }),
        expect.objectContaining({ ts: "t2", issue: 2, reason: "no-sentinel" }),
      ],
    });

    const first = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });
    const toonPath = join(root, ".red/state/afk-history.toonl");
    const afterFirst = await readFile(toonPath, "utf8");
    const second = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });

    expect(first.status).toBe("converted");
    expect(first.converted).toEqual(["dev.afk-history"]);
    expect(afterFirst.split("\n")[0]).toBe("[2]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:");
    expect(second.status).toBe("noop");
    expect(second.skipped).toEqual(["dev.afk-history"]);
    expect(await readFile(toonPath, "utf8")).toBe(afterFirst);
    await expect(readRegisteredToonSurface(root, "dev.afk-history")).resolves.toMatchObject({
      format: "toonl",
      value: [
        expect.objectContaining({ ts: "t1", issue: 1 }),
        expect.objectContaining({ ts: "t2", issue: 2, reason: "no-sentinel" }),
      ],
    });
  });

  test("converts legacy agent lane JSONL to TOONL through the registry and skips crash tails", async () => {
    const root = await scratch();
    await write(
      root,
      ".red/tmp/agent.log.jsonl",
      [
        JSON.stringify({ ts: "t1", worker: "wA", type: "agent", msg: "line A", iteration: "1", kind: "text" }),
        "{torn crash tail",
        JSON.stringify({ ts: "t2", worker: "wA", issue: 2, attempt: 1, type: "agent", msg: "line B", iteration: "2", kind: "toolCall" }),
        "",
      ].join("\n"),
    );

    const report = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });
    const toonPath = join(root, ".red/tmp/agent.log.toonl");
    const body = await readFile(toonPath, "utf8");

    expect(report.converted).toContain("dev.agent-log");
    expect(body.split("\n")[0]).toBe("[2]{ts,lvl,worker,issue,attempt,type,msg,iteration,kind}:");
    await expect(readRegisteredToonSurface(root, "dev.agent-log")).resolves.toMatchObject({
      format: "toonl",
      value: [
        expect.objectContaining({ ts: "t1", worker: "wA", type: "agent", msg: "line A" }),
        expect.objectContaining({ ts: "t2", issue: 2, attempt: 1, type: "agent", msg: "line B" }),
      ],
    });
  });

  test("converts legacy code-understanding bench runs JSONL to TOONL through the registry", async () => {
    const root = await scratch();
    await write(
      root,
      ".red/tmp/bench/code-understanding/runs.jsonl",
      [
        JSON.stringify({
          schema_version: "redskills.code_understanding_bench.run.v1",
          generated_at: "2026-06-01T00:00:00.000Z",
          benchmark: "code-understanding",
          runner: "codex",
          arm: "none",
          corpus: "overlap",
          case_id: "case",
          language: "typescript",
          repo: "repo",
          repo_path: "repo-path",
          question: "question",
          run_index: 1,
          status: "pass",
          duration_ms: 100,
          exit_code: 0,
          signal: null,
          log_path: null,
          mcp_config_path: null,
          command: ["codex"],
          metrics: {
            tools: { total: 0, read: 0, grep: 0, bash: 0, mcp: 0, byName: {} },
            tokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0, total: 15 },
            cost_usd: null,
          },
        }),
        "",
      ].join("\n"),
    );

    const report = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });
    const toonPath = join(root, ".red/tmp/bench/code-understanding/runs.toonl");
    const body = await readFile(toonPath, "utf8");

    expect(report.converted).toContain("dev.code-understanding-bench-runs");
    expect(body.trimStart()).toMatch(/^\[1\](?:\{|:)/);
    await expect(readRegisteredToonSurface(root, "dev.code-understanding-bench-runs")).resolves.toMatchObject({
      format: "toonl",
      value: [
        expect.objectContaining({
          schema_version: "redskills.code_understanding_bench.run.v1",
          arm: "none",
          metrics: expect.objectContaining({
            tokens: expect.objectContaining({ total: 15 }),
          }),
        }),
      ],
    });
  });

  test("converts legacy dev snapshot states and statusline caches in place", async () => {
    const root = await scratch();
    await write(
      root,
      ".red/tmp/workers/wA/1783-a1/afk.state.json",
      JSON.stringify({ worker_id: "wA", pid: 0, current: { number: 1783, activity: "impl" } }),
    );
    await write(root, ".red/tmp/statusline-cache.json", JSON.stringify({ queue: 4, human: 1, ts: 100 }));
    await write(
      root,
      ".red/tmp/statusline-repo-cache.json",
      JSON.stringify({ baseRef: "origin/main", openPrs: 2, todayPrs: 1, openIssues: 8, localAdded: 5, localRemoved: 2, ts: 100 }),
    );
    await write(
      root,
      ".red/tmp/rsp-resident.pid.json",
      JSON.stringify({ version: 1, pid: 0, socket_path: "sock", store_uri: "file://store", resident_version: "old", started_at: "t" }),
    );
    await write(root, ".red/tmp/rsp-status-summary.json", JSON.stringify({ version: 1, tokens_saved_today: 12, updated_at: "t" }));
    await write(
      root,
      ".red/tmp/waits/wait-a.json",
      JSON.stringify({ id: "wait-a", target: "cmd:test", reason: "legacy", pid: 0, started_at: "t", poll_tier: "local", status: "running" }),
    );

    const first = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });
    const second = await convertRegisteredToonSurfaces({ rootDir: root, plugin: "dev" });

    expect(first.converted).toEqual(
      expect.arrayContaining([
        "dev.attempt-state",
        "dev.statusline-count-cache",
        "dev.statusline-repo-cache",
        "dev.rsp-resident-registry",
        "dev.rsp-status-summary",
        "dev.rsp-wait-registry",
      ]),
    );
    const stateRaw = await readFile(join(root, ".red/tmp/workers/wA/1783-a1/afk.state.json"), "utf8");
    const countRaw = await readFile(join(root, ".red/tmp/statusline-cache.json"), "utf8");
    const repoRaw = await readFile(join(root, ".red/tmp/statusline-repo-cache.json"), "utf8");
    const residentRaw = await readFile(join(root, ".red/tmp/rsp-resident.pid.json"), "utf8");
    const summaryRaw = await readFile(join(root, ".red/tmp/rsp-status-summary.json"), "utf8");
    const waitRaw = await readFile(join(root, ".red/tmp/waits/wait-a.json"), "utf8");
    expect(stateRaw.trimStart().startsWith("{")).toBe(false);
    expect(countRaw.trimStart().startsWith("{")).toBe(false);
    expect(repoRaw.trimStart().startsWith("{")).toBe(false);
    expect(residentRaw.trimStart().startsWith("{")).toBe(false);
    expect(summaryRaw.trimStart().startsWith("{")).toBe(false);
    expect(waitRaw.trimStart().startsWith("{")).toBe(false);
    expect((decode(stateRaw) as { current?: { number?: number } }).current?.number).toBe(1783);
    expect((decode(countRaw) as { queue?: number }).queue).toBe(4);
    expect((decode(repoRaw) as { openPrs?: number }).openPrs).toBe(2);
    expect((decode(residentRaw) as { resident_version?: string }).resident_version).toBe("old");
    expect((decode(summaryRaw) as { tokens_saved_today?: number }).tokens_saved_today).toBe(12);
    expect((decode(waitRaw) as { reason?: string }).reason).toBe("legacy");
    expect(second.status).toBe("noop");
    expect(second.skipped).toEqual(
      expect.arrayContaining([
        "dev.attempt-state",
        "dev.statusline-count-cache",
        "dev.statusline-repo-cache",
        "dev.rsp-resident-registry",
        "dev.rsp-status-summary",
        "dev.rsp-wait-registry",
      ]),
    );
  });
});
