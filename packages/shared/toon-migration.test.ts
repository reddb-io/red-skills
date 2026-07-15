import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { encode } from "@reddb-io/toon";
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
      ]),
    );
    expect(registeredToonSurfacesForPlugin("dev").map((surface) => surface.id)).toContain("dev.afk-history");
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
});
