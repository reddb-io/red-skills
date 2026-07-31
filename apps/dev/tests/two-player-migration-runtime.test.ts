import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { afkStateDir, tmpDir, workersDir } from "@reddb-io/shared/red-paths.js";
import {
  migrateToTwoPlayer,
  twoPlayerReportPath,
  type TwoPlayerMigrationDeps,
} from "../src/runtime/two-player-migration.js";
import { TWO_PLAYER_CONTRACT, TWO_PLAYER_RECOVERY_DOC } from "../src/core/two-player-migration.js";

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "two-player-"));
  await mkdir(tmpDir(root), { recursive: true });
  await mkdir(afkStateDir(root), { recursive: true });
  return root;
}

async function seedWorker(root: string, workerId: string, issue: number, pid: number): Promise<void> {
  const workspace = join(workersDir(root), workerId);
  await mkdir(join(workspace, String(issue)), { recursive: true });
  await writeFile(join(workspace, "worker.pid"), `${pid}\n`, "utf8");
}

async function seedRuntime(root: string, pid: number): Promise<void> {
  const dir = join(tmpDir(root), "supervisors", "default");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "afk-supervisor.pid"), `${pid}\n`, "utf8");
}

interface Recorder {
  stopped: number[];
  notices: string[];
  deps: Partial<TwoPlayerMigrationDeps>;
}

function recorder(overrides: Partial<TwoPlayerMigrationDeps> = {}): Recorder {
  const stopped: number[] = [];
  const notices: string[] = [];
  return {
    stopped,
    notices,
    deps: {
      isLivePid: () => true,
      stopTree: async (pid) => {
        stopped.push(pid);
        return true;
      },
      projectLabel: () => "red-skills",
      hostWorkers: async () => new Map<string, string>(),
      isRegistered: async () => false,
      now: () => new Date("2026-07-31T12:00:00.000Z"),
      notice: (message) => notices.push(message),
      ...overrides,
    },
  };
}

describe("migrateToTwoPlayer", () => {
  it("stays inert until the two-player era is declared", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    const rec = recorder();
    const result = await migrateToTwoPlayer(root, { env: {}, deps: rec.deps });
    expect(result.status).toBe("inactive");
    expect(rec.stopped).toEqual([]);
  });

  it("stops the per-project runtime and leaves the live Worker running", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    await seedWorker(root, "wAAAA", 42, 111);
    const rec = recorder();
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    expect(result.status).toBe("migrated");
    expect(rec.stopped).toEqual([900]);
    expect(rec.stopped).not.toContain(111);
  });

  it("re-adopts a live Worker under this project's label, proven by host state", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 42, 111);
    const adopted = new Map<string, string>();
    const rec = recorder({
      hostWorkers: async () => new Map(adopted),
      readopt: async (workerId, label) => {
        adopted.set(workerId, label);
        return true;
      },
    });
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    expect(result.report?.moved.readopted).toEqual(["wAAAA (#42)"]);
    expect(adopted.get("wAAAA")).toBe("red-skills");
  });

  it("names a Worker the host would not re-adopt instead of dropping it", async () => {
    const root = await freshRoot();
    await seedWorker(root, "wAAAA", 42, 111);
    const rec = recorder({ readopt: async () => false });
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    expect(result.report?.moved.failed).toEqual(["wAAAA (#42)"]);
    expect(result.report?.moved.readopted).toEqual([]);
  });

  it("leaves the registration to the MCP and says so in the report", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    const rec = recorder();
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    expect(result.plan.actions.map((action) => action.kind)).toEqual(["stop-runtime"]);
    expect(result.report?.kept.map((entry) => entry.subject)).toContain("red-skills");
  });

  it("reports what it moved and what it left behind, with the way back", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    await seedWorker(root, "wAAAA", 42, 111);
    const rec = recorder({ readopt: async () => true });
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    const raw = await readFile(twoPlayerReportPath(root), "utf8");
    const stamped = decode(raw) as { contract: string; recovery: string };
    expect(stamped.contract).toBe(TWO_PLAYER_CONTRACT);
    expect(stamped.recovery).toBe(TWO_PLAYER_RECOVERY_DOC);
    expect(result.report?.moved.stopped).toEqual(["project runtime pid 900"]);
    expect(result.report?.kept.length).toBeGreaterThan(0);
    expect(rec.notices.join("\n")).toContain(TWO_PLAYER_RECOVERY_DOC);
  });

  it("changes nothing the second time it runs", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    await seedWorker(root, "wAAAA", 42, 111);
    const first = recorder({ readopt: async () => true });
    await migrateToTwoPlayer(root, { active: true, deps: first.deps });
    const before = await readFile(twoPlayerReportPath(root), "utf8");

    const second = recorder({ readopt: async () => true });
    const result = await migrateToTwoPlayer(root, { active: true, deps: second.deps });
    expect(result.status).toBe("already-migrated");
    expect(second.stopped).toEqual([]);
    expect(result.plan.actions).toEqual([]);
    expect(await readFile(twoPlayerReportPath(root), "utf8")).toBe(before);
  });

  it("never fails a launch when the host refuses every move", async () => {
    const root = await freshRoot();
    await seedRuntime(root, 900);
    const rec = recorder({
      stopTree: async () => {
        throw new Error("refused");
      },
    });
    const result = await migrateToTwoPlayer(root, { active: true, deps: rec.deps });
    expect(result.status).toBe("migrated");
    expect(result.report?.moved.failed).toEqual(["project runtime pid 900"]);
  });
});

describe("the documented way back", () => {
  it("is written where the report and the boot notice point", async () => {
    const [file] = TWO_PLAYER_RECOVERY_DOC.split("#");
    const doc = await readFile(join(process.cwd(), "..", "..", file as string), "utf8");
    expect(doc).toContain("## Recovering from a bad two-player migration");
    expect(doc).toContain("RED_TWO_PLAYER_CUTOVER");
    expect(doc).toContain("two-player.toon");
  });
});
