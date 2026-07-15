import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { afkStateDir, statuslineStateDir, tmpDir } from "@reddb-io/shared/red-paths.js";
import { migrateLegacyDevPaths } from "./red-path-migration.js";

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

afterEach(() => {
  // temp dirs live under the OS tmp; leave them for the OS reaper.
  roots.length = 0;
});

describe("migrateLegacyDevPaths", () => {
  it("relocates legacy durable artifacts to the state tier and reports them", async () => {
    const root = await freshRoot();
    const tmp = tmpDir(root);
    await writeFile(join(tmp, "afk-supervisor.pid"), "123", "utf8");
    await writeFile(join(tmp, "statusline-cache.json"), "{}", "utf8");
    await writeFile(join(tmp, "afk-supervisor.log"), "log", "utf8");
    await writeFile(join(tmp, "afk-supervisor.log.jsonl"), "{}", "utf8");
    await mkdir(join(tmp, "runner-circuit"), { recursive: true });
    await writeFile(join(tmp, "runner-circuit", "claude.json"), "{}", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(await readFile(join(afkStateDir(root), "afk-supervisor.pid"), "utf8")).toBe("123");
    expect(await readFile(join(statuslineStateDir(root), "statusline-cache.json"), "utf8")).toBe("{}");
    expect(await readFile(join(afkStateDir(root), "afk-supervisor.log.jsonl"), "utf8")).toBe("{}");
    expect(await readFile(join(afkStateDir(root), "runner-circuit", "claude.json"), "utf8")).toBe("{}");
    // Legacy copies are gone (moved, not copied).
    expect(await exists(join(tmp, "afk-supervisor.pid"))).toBe(false);
    expect(moved).toContain("afk-supervisor.pid");
    expect(moved).toContain("afk-supervisor.log.jsonl");
  });

  it("is a no-op on a second boot (idempotent)", async () => {
    const root = await freshRoot();
    await writeFile(join(tmpDir(root), "afk-supervisor.pid"), "9", "utf8");
    await migrateLegacyDevPaths(root);
    const second = await migrateLegacyDevPaths(root);
    expect(second.moved).toEqual([]);
    expect(await readFile(join(afkStateDir(root), "afk-supervisor.pid"), "utf8")).toBe("9");
  });

  it("never deletes the legacy copy when the canonical copy already exists (ambiguous)", async () => {
    const root = await freshRoot();
    const legacy = join(tmpDir(root), "afk-supervisor.pid");
    const current = join(afkStateDir(root), "afk-supervisor.pid");
    await writeFile(legacy, "legacy", "utf8");
    await mkdir(afkStateDir(root), { recursive: true });
    await writeFile(current, "current", "utf8");

    const { moved } = await migrateLegacyDevPaths(root);

    expect(moved).not.toContain("afk-supervisor.pid");
    expect(await readFile(legacy, "utf8")).toBe("legacy");
    expect(await readFile(current, "utf8")).toBe("current");
  });
});
