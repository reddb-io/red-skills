import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createMemoryBackup,
  listMemoryBackups,
  readMemoryBackupManifest,
  restoreMemoryBackup,
} from "../src/backup.js";
import { readConfig } from "../src/config.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import { decodeMemoryStateDocument } from "../src/toon-state.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix = "memory-backup-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory backup snapshots", () => {
  test("creates inspectable SHA-256 manifest snapshots without copying old backups", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    await mkdir(join(root, ".red/memory/notes"), { recursive: true });
    await writeFile(join(root, ".red/memory/notes/auth.md"), "JWT rotation note\n", "utf8");

    const first = await createMemoryBackup(root, { name: "before-auth", now: 1_700_000_000_000 });
    expect(first.manifest).toMatchObject({
      schema_version: "memory.backup.v1",
      name: "before-auth",
      mode: "markdown-only",
    });
    expect(first.manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["config.toon", "notes/auth.md"]),
    );
    expect(first.manifest.files.some((file) => file.path.startsWith("backups/"))).toBe(false);
    await expect(readFile(join(root, ".red/memory/backups/before-auth/manifest.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const manifestRaw = await readFile(join(root, ".red/memory/backups/before-auth/manifest.toon"), "utf8");
    expect(manifestRaw.trimStart().startsWith("{")).toBe(false);
    expect(decodeMemoryStateDocument(manifestRaw)).toMatchObject({ name: "before-auth" });

    const manifest = await readMemoryBackupManifest(root, "before-auth");
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);

    const listed = await listMemoryBackups(root);
    expect(listed).toEqual([
      expect.objectContaining({ name: "before-auth", files: first.files, bytes: first.bytes }),
    ]);
  });

  test("restore replaces project Memory state and creates a safety backup", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const notes = join(root, ".red/memory/notes");
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "auth.md"), "old auth memory\n", "utf8");

    await createMemoryBackup(root, { name: "good", now: 1_700_000_000_000 });
    await writeFile(join(notes, "auth.md"), "new auth memory\n", "utf8");
    await writeFile(join(notes, "extra.md"), "extra memory\n", "utf8");

    const restored = await restoreMemoryBackup(root, "good", {
      now: 1_700_000_100_000,
      safetyName: "safety",
    });
    expect(restored).toMatchObject({
      restored_from: "good",
      safety_backup: { manifest: { name: "safety" } },
    });
    expect(await readFile(join(notes, "auth.md"), "utf8")).toBe("old auth memory\n");
    await expect(readFile(join(notes, "extra.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readConfig(root)).toMatchObject({ mode: "markdown-only" });
    expect((await listMemoryBackups(root)).map((backup) => backup.name)).toEqual(
      expect.arrayContaining(["good", "safety"]),
    );
  });

  test("restore verifies backup files before replacing current state", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const notes = join(root, ".red/memory/notes");
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "auth.md"), "safe current memory\n", "utf8");

    await createMemoryBackup(root, { name: "corrupt-me" });
    await writeFile(
      join(root, ".red/memory/backups/corrupt-me/data/notes/auth.md"),
      "tampered backup\n",
      "utf8",
    );

    await expect(restoreMemoryBackup(root, "corrupt-me")).rejects.toThrow(
      "backup file verification failed",
    );
    expect(await readFile(join(notes, "auth.md"), "utf8")).toBe("safe current memory\n");
  });

  test(
    "CLI creates, lists, inspects, and restores graph-mode persistence",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      const oldStore = runMemory(["store", "JWT tokens rotate every 90 days.", "--root", root]);
      expect(oldStore.status, oldStore.stderr).toBe(0);

      const created = runMemory(["backup", "create", "--root", root, "--name", "before-new", "--json"]);
      expect(created.status, created.stderr).toBe(0);
      const backup = JSON.parse(created.stdout) as { manifest: { files: Array<{ path: string }> } };
      expect(backup.manifest.files.some((file) => file.path === "config.toon")).toBe(true);
      expect(backup.manifest.files.some((file) => file.path.startsWith("graph.rdb"))).toBe(true);

      const newStore = runMemory(["store", "Database passwords live in Vault.", "--root", root]);
      expect(newStore.status, newStore.stderr).toBe(0);

      const list = runMemory(["backup", "list", "--root", root, "--json"]);
      expect(list.status, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout).backups[0]).toMatchObject({ name: "before-new" });

      const inspect = runMemory(["backup", "inspect", "before-new", "--root", root, "--json"]);
      expect(inspect.status, inspect.stderr).toBe(0);
      expect(JSON.parse(inspect.stdout)).toMatchObject({ name: "before-new", mode: "graph" });

      const rejected = runMemory(["backup", "restore", "before-new", "--root", root]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("requires explicit --yes");

      const restored = runMemory(["backup", "restore", "before-new", "--root", root, "--yes", "--json"]);
      expect(restored.status, restored.stderr).toBe(0);
      const restoredBody = JSON.parse(restored.stdout) as {
        restored_from: string;
        safety_backup: { manifest: { name: string } };
      };
      expect(restoredBody.restored_from).toBe("before-new");
      expect(restoredBody.safety_backup.manifest.name).toContain("pre-restore-");

      const oldRecall = runMemory(["recall", "JWT rotate", "--root", root, "--json"]);
      expect(oldRecall.status, oldRecall.stderr).toBe(0);
      expect(oldRecall.stdout).toContain("JWT tokens rotate every 90 days.");

      const newRecall = runMemory(["recall", "Vault password", "--root", root, "--json"]);
      expect(newRecall.status, newRecall.stderr).toBe(0);
      expect(newRecall.stdout).not.toContain("Database passwords live in Vault.");
    },
    TIMEOUT,
  );
});
